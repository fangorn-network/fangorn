import {
    ContractFunctionArgs,
    ContractFunctionName,
    GetContractEventsReturnType,
    concatHex,
    encodeFunctionData,
    keccak256,
    toHex,
    type Address,
    type Hash,
    type Hex,
    type PublicClient,
    type WalletClient,
} from "viem";

import { DATA_REGISTRY_ABI } from "./abi.js";

// Mirroring the contract's explicit lifecycle status codes
export enum PublisherStatus {
    UNREGISTERED = 0,
    ACTIVE = 1,
    SUSPENDED = 2,
}

/**
 * The on-chain id of a namespace within an app: the SDK's human-readable
 * namespace name, hashed. Names never touch storage — the contract only ever
 * sees these 32 bytes.
 */
export function subspaceId(namespace: string): Hex {
    return keccak256(toHex(namespace));
}

/**
 * The composite storage key the contract derives for `app:publisher:subspace`.
 * Mirrors `namespace_key()` in contracts/data_registry — keccak256 over the
 * packed 84 bytes. Computing it client-side is what lets a subscriber filter
 * one exact subspace with a single indexed topic.
 */
export function namespaceKey(
    appId: Hex,
    publisher: Address,
    subspace: Hex,
): Hex {
    return keccak256(concatHex([appId, publisher, subspace]));
}

type StateCommittedEventLog = GetContractEventsReturnType<
    typeof DATA_REGISTRY_ABI,
    "StateCommitted"
>[number];

/**
 * A decoded `StateCommitted` log — the single on-chain signal that one
 * hierarchical namespace's state root advanced. `logId` uniquely identifies the
 * emitting log (tx + index) so consumers can dedupe across the catch-up
 * (getLogs) and live (watch) paths.
 */
export interface StateCommittedLog {
    namespaceKey: Hex;
    appId: Hex;
    publisher: Address;
    subspaceId: Hex;
    oldRoot: Hex;
    newRoot: Hex;
    blockNumber: bigint;
    logId: string;
}

/**
 * Which slice of the app's commit stream to read. Every field is an indexed
 * topic, so filtering happens on the RPC node — no indexer, no subgraph:
 *
 *   {}                          — the whole app, every publisher and subspace
 *   { publisher }               — one publisher's commits across the app
 *   { publisher, namespace }    — one exact subspace (the tightest filter)
 *
 * `namespace` alone is not filterable: the key binds the publisher too, so a
 * subspace name across all publishers means filtering the app stream in memory.
 */
export interface CommitFilter {
    publisher?: Address;
    namespace?: string;
}

/**
 * An unsigned transaction, hex-encoded and ready to hand to a browser wallet's
 * `eth_sendTransaction` — no `from`, since the signing wallet supplies it.
 */
export interface PreparedTx {
    to: Address;
    data: Hex;
    chainId: number | undefined;
    gas: Hex;
    maxFeePerGas: Hex;
    maxPriorityFeePerGas: Hex;
}

function decodeStateCommitted(log: StateCommittedEventLog): StateCommittedLog {
    const a = log.args;
    if (
        a.namespace_key === undefined ||
        a.app_id === undefined ||
        a.publisher === undefined ||
        a.subspace_id === undefined ||
        a.old_root === undefined ||
        a.new_root === undefined
    ) {
        throw new Error("Malformed log event: incomplete StateCommitted args");
    }

    return {
        namespaceKey: a.namespace_key,
        appId: a.app_id,
        publisher: a.publisher,
        subspaceId: a.subspace_id,
        oldRoot: a.old_root,
        newRoot: a.new_root,
        blockNumber: log.blockNumber,
        logId: `${log.transactionHash}:${log.logIndex.toString()}`,
    };
}

export class DataRegistryClient {
    constructor(
        private contractAddress: Address,
        private appId: Hex,
        private publicClient: PublicClient,
        private walletClient: WalletClient,
    ) { }

    /** The app namespace every call on this client is scoped to. */
    getAppId(): Hex {
        return this.appId;
    }

    /** Re-scope every subsequent call to a different app. See `Fangorn.setAppId`. */
    setAppId(appId: Hex): void {
        this.appId = appId;
    }

    private getWriteConfig() {
        if (!this.walletClient.chain) throw new Error("Chain required");
        if (!this.walletClient.account) throw new Error("Account required");

        return {
            chain: this.walletClient.chain,
            account: this.walletClient.account,
        };
    }

    /**
     * Internal helper to execute state-mutating transactions
     * matching the exact gas buffer and aggressive fee styling of the protocol.
     */
    private async executeWrite<
        TFunctionName extends ContractFunctionName<typeof DATA_REGISTRY_ABI, "payable" | "nonpayable">
    >(
        functionName: TFunctionName,
        args: ContractFunctionArgs<typeof DATA_REGISTRY_ABI, "payable" | "nonpayable", TFunctionName>,
        value?: bigint
    ): Promise<Hash> {
        const { chain, account } = this.getWriteConfig();

        const fees = await this.publicClient.estimateFeesPerGas();

        const gas: bigint = await this.publicClient.estimateContractGas({
            address: this.contractAddress,
            abi: DATA_REGISTRY_ABI,
            functionName,
            args, // TypeScript now guarantees this matches the function's strict tuple definition
            account,
            value,
        } as unknown as Parameters<typeof this.publicClient.estimateContractGas>[0]); // Safe escape hatch avoiding 'any'

        const hash = await this.walletClient.writeContract({
            address: this.contractAddress,
            abi: DATA_REGISTRY_ABI,
            functionName,
            args,
            chain,
            account,
            gas: (gas * 130n) / 100n,
            maxFeePerGas: fees.maxFeePerGas * 3n, // Redundant nullish coalescing removed
            maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
            value,
        } as unknown as Parameters<typeof this.walletClient.writeContract>[0]);
        await this.publicClient.waitForTransactionReceipt({ hash });
        return hash;
    }

    /** The composite key for one of this app's namespaces. */
    namespaceKey(publisher: Address, namespace: string): Hex {
        return namespaceKey(this.appId, publisher, subspaceId(namespace));
    }

    // ── Writes ───────────────────────────────────────────────────────────────

    /**
     * Claim this client's `appId` on-chain. First come, first served — an app
     * must own its id before any publisher can commit under it.
     */
    async registerApp(): Promise<Hash> {
        return this.executeWrite("registerApp", [this.appId]);
    }

    /**
     * Register as a new data publisher or reactivate a suspended account.
     * Automatically reads the required on-chain fee and attaches it to the call.
     */
    async register(): Promise<Hash> {
        const fee = await this.registrationFee();
        return this.executeWrite("register", [], fee);
    }

    /**
     * The single mutating state gateway route. Enforces the sequential
     * Compare-And-Swap (CAS) timeline rule — per namespace, so concurrent pushes
     * to *different* namespaces never contend.
     */
    async commitStateRoot(
        namespace: string,
        oldRoot: Hex,
        newRoot: Hex,
    ): Promise<Hash> {
        return this.executeWrite("commitStateRoot", [
            this.appId,
            subspaceId(namespace),
            oldRoot,
            newRoot,
        ]);
    }

    /**
     * Build the `commitStateRoot` call as an UNSIGNED transaction for `publisher`
     * to sign, instead of sending it from this client's wallet.
     *
     * This is the self-custodial publish path: a relay server builds and pins the
     * commit with a keyless service wallet, then hands this back for the user's
     * browser wallet to sign. The server never holds the key that moves the head,
     * and the on-chain sender IS the publisher — which is what authenticates the
     * publish, since the contract keys the namespace by `msg_sender`.
     */
    async prepareCommitStateRoot(
        publisher: Address,
        namespace: string,
        oldRoot: Hex,
        newRoot: Hex,
    ): Promise<PreparedTx> {
        const data = encodeFunctionData({
            abi: DATA_REGISTRY_ABI,
            functionName: "commitStateRoot",
            args: [this.appId, subspaceId(namespace), oldRoot, newRoot],
        });

        // Quote fees and gas here rather than leaving them to the wallet. Wallet
        // estimation runs too tight against a live L2 base fee, and an
        // eth_estimateGas from the wallet against a public RPC is what surfaces
        // as "Network fee Unavailable" in MetaMask. maxFeePerGas is only a
        // ceiling — you pay base+priority — so headroom costs nothing.
        const fees = await this.publicClient.estimateFeesPerGas();

        // Simulating here also turns a would-be revert (a stale root, an
        // unregistered app) into a clear error now, instead of a cryptic wallet
        // message after the user has already clicked sign.
        let gas: bigint;
        try {
            const estimate = await this.publicClient.estimateGas({
                account: publisher,
                to: this.contractAddress,
                data,
            });
            gas = (estimate * 3n) / 2n;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (/revert/i.test(message)) {
                throw new Error(
                    `settlement would revert — the head may have moved on-chain, or the app is unregistered: ${message}`,
                );
            }
            gas = 5_000_000n; // RPC hiccup, not a revert — proceed with a safe ceiling
        }

        return {
            to: this.contractAddress,
            data,
            chainId: this.publicClient.chain?.id,
            gas: toHex(gas),
            maxFeePerGas: toHex(fees.maxFeePerGas * 2n),
            maxPriorityFeePerGas: toHex(fees.maxPriorityFeePerGas),
        };
    }

    // ── Views ────────────────────────────────────────────────────────────────

    /**
     * Obtains the authoritative timeline tracking anchor for one publisher's
     * namespace within this app.
     */
    async getNamespaceHead(publisher: Address, namespace: string): Promise<Hex> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: DATA_REGISTRY_ABI,
            functionName: "getNamespaceHead",
            args: [this.appId, publisher, subspaceId(namespace)],
        });
    }

    /** Owner of this client's app id, or the zero address if unclaimed. */
    async getAppOwner(): Promise<Address> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: DATA_REGISTRY_ABI,
            functionName: "getAppOwner",
            args: [this.appId],
        });
    }

    /**
     * Reads the explicit enum lifecycle state from the registry status machine.
     */
    async getPublisherStatus(publisher: Address): Promise<PublisherStatus> {
        const status = await this.publicClient.readContract({
            address: this.contractAddress,
            abi: DATA_REGISTRY_ABI,
            functionName: "getPublisherStatus",
            args: [publisher],
        });
        return status as PublisherStatus;
    }

    /**
     * Helper boolean view returning true if a publisher can currently commit data.
     */
    async isRegistered(publisher: Address): Promise<boolean> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: DATA_REGISTRY_ABI,
            functionName: "isRegistered",
            args: [publisher],
        });
    }

    /** Current chain head block number — the default "start here" for a fresh subscription. */
    async currentBlock(): Promise<bigint> {
        return this.publicClient.getBlockNumber();
    }

    // ── Subscription (light-client) ────────────────────────────────────────────

    /** Translate a `CommitFilter` into indexed-topic args for this app. */
    private topicsFor(filter: CommitFilter) {
        const { publisher, namespace } = filter;
        return {
            app_id: this.appId,
            ...(publisher ? { publisher } : {}),
            ...(publisher && namespace
                ? { namespace_key: this.namespaceKey(publisher, namespace) }
                : {}),
        };
    }

    /**
     * Historical `StateCommitted` logs for one slice of this app, oldest →
     * newest — the catch-up path for a subscriber resuming from a saved block
     * cursor. Node-side filtered by indexed topics, so no indexer is involved.
     */
    async getStateCommittedLogs(
        filter: CommitFilter,
        fromBlock: bigint,
        toBlock?: bigint,
    ): Promise<StateCommittedLog[]> {
        const logs = await this.publicClient.getContractEvents({
            address: this.contractAddress,
            abi: DATA_REGISTRY_ABI,
            eventName: "StateCommitted",
            args: this.topicsFor(filter),
            fromBlock,
            toBlock: toBlock ?? "latest",
        });
        return logs
            .map(decodeStateCommitted)
            .filter((log) => matchesFilter(log, filter))
            .sort((a, b) =>
                a.blockNumber === b.blockNumber
                    ? a.logId.localeCompare(b.logId)
                    : a.blockNumber < b.blockNumber ? -1 : 1,
            );
    }

    /**
     * Live-watch `StateCommitted` for one slice of this app. Returns an
     * unsubscribe function. Uses the client's transport (polling over HTTP, push
     * over a WebSocket transport) — reads logs straight from the RPC node, no
     * subgraph.
     */
    watchStateCommitted(
        filter: CommitFilter,
        onCommit: (log: StateCommittedLog) => void,
        onError?: (err: Error) => void,
        pollingInterval?: number,
    ): () => void {
        return this.publicClient.watchContractEvent({
            address: this.contractAddress,
            abi: DATA_REGISTRY_ABI,
            eventName: "StateCommitted",
            args: this.topicsFor(filter),
            pollingInterval,
            onLogs: (logs) => {
                for (const raw of logs) {
                    const log = decodeStateCommitted(raw);
                    if (matchesFilter(log, filter)) onCommit(log);
                }
            },
            onError,
        });
    }

    async publisherCount(): Promise<bigint> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: DATA_REGISTRY_ABI,
            functionName: "publisherCount",
        });
    }

    async registrationFee(): Promise<bigint> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: DATA_REGISTRY_ABI,
            functionName: "registrationFee",
        });
    }

    async admin(): Promise<Address> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: DATA_REGISTRY_ABI,
            functionName: "admin",
        });
    }

    // ── Admin Functions ──────────────────────────────────────────────────────

    /**
     * Allows governance or protocol administrator to immediately freeze a publisher namespace.
     */
    async suspendPublisher(publisher: Address): Promise<Hash> {
        return this.executeWrite("suspendPublisher", [publisher]);
    }

    /**
     * Adjusts the current native/token onboarding collateral tier.
     */
    async setRegistrationFee(fee: bigint): Promise<Hash> {
        return this.executeWrite("setRegistrationFee", [fee]);
    }
}

/**
 * The in-memory half of a filter. `subspace_id` is not an indexed topic (the
 * three slots go to namespace_key/app_id/publisher), so a namespace-without-
 * publisher filter — "every publisher's `docs` namespace" — narrows here
 * instead of on the node.
 */
function matchesFilter(log: StateCommittedLog, filter: CommitFilter): boolean {
    if (!filter.namespace || filter.publisher) return true;
    return log.subspaceId === subspaceId(filter.namespace);
}
