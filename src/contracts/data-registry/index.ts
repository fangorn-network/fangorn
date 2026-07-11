import {
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
 * A decoded `StateCommitted(publisher, old_root, new_root)` log — the single
 * on-chain signal that a publisher's state root advanced. `logId` uniquely
 * identifies the emitting log (tx + index) so consumers can dedupe across the
 * catch-up (getLogs) and live (watch) paths.
 */
export interface StateCommittedLog {
    oldRoot: Hex;
    newRoot: Hex;
    blockNumber: bigint;
    logId: string;
}

function decodeStateCommitted(log: any): StateCommittedLog {
    return {
        oldRoot: log.args.old_root as Hex,
        newRoot: log.args.new_root as Hex,
        blockNumber: log.blockNumber as bigint,
        logId: `${log.transactionHash as string}:${String(log.logIndex)}`,
    };
}

export class DataRegistryClient {
    constructor(
        private contractAddress: Address,
        private publicClient: PublicClient,
        private walletClient: WalletClient,
    ) { }

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
    private async executeWrite(
        functionName: string,
        args: any[],
        value?: bigint
    ): Promise<Hash> {
        const { chain, account } = this.getWriteConfig();

        const fees = await this.publicClient.estimateFeesPerGas();

        const gas = await this.publicClient.estimateContractGas({
            address: this.contractAddress,
            abi: DATA_REGISTRY_ABI,
            functionName,
            args,
            account,
            value,
        });

        const hash = await this.walletClient.writeContract({
            address: this.contractAddress,
            abi: DATA_REGISTRY_ABI,
            functionName,
            args,
            chain,
            account,
            gas: (gas * 130n) / 100n, // 30% gas buffer safety margin
            maxFeePerGas: (fees.maxFeePerGas ?? 0n) * 3n,
            maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
            value,
        });

        await this.publicClient.waitForTransactionReceipt({ hash });

        return hash;
    }

    // ── Writes ───────────────────────────────────────────────────────────────

    /**
     * Register as a new data publisher or reactivate a suspended account.
     * Automatically reads the required on-chain fee and attaches it to the call.
     */
    async register(): Promise<Hash> {
        const fee = await this.registrationFee();
        return this.executeWrite("register", [], fee);
    }

    /**
     * The single mutating state gateway route. 
     * Enforces the sequential Compare-And-Swap (CAS) timeline rule.
     */
    async commitStateRoot(oldRoot: Hex, newRoot: Hex): Promise<Hash> {
        return this.executeWrite("commitStateRoot", [oldRoot, newRoot]);
    }

    // ── Views ────────────────────────────────────────────────────────────────

    /**
     * Obtains the authoritative timeline tracking anchor for a specific publisher's tree.
     */
    async getNamespaceHead(publisher: Address): Promise<Hex> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: DATA_REGISTRY_ABI,
            functionName: "getNamespaceHead",
            args: [publisher],
        }) as Promise<Hex>;
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
        return Number(status) as PublisherStatus;
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
        }) as Promise<boolean>;
    }

    /** Current chain head block number — the default "start here" for a fresh subscription. */
    async currentBlock(): Promise<bigint> {
        return this.publicClient.getBlockNumber();
    }

    // ── Subscription (light-client) ────────────────────────────────────────────

    /**
     * Historical `StateCommitted` logs for one publisher, oldest → newest — the
     * catch-up path for a subscriber resuming from a saved block cursor. Node-side
     * filtered by the indexed `publisher` topic, so no indexer is involved.
     */
    async getStateCommittedLogs(
        publisher: Address,
        fromBlock: bigint,
        toBlock?: bigint,
    ): Promise<StateCommittedLog[]> {
        const logs = await this.publicClient.getContractEvents({
            address: this.contractAddress,
            abi: DATA_REGISTRY_ABI,
            eventName: "StateCommitted",
            args: { publisher },
            fromBlock,
            toBlock: toBlock ?? "latest",
        });
        return logs
            .map(decodeStateCommitted)
            .sort((a, b) =>
                a.blockNumber === b.blockNumber
                    ? a.logId.localeCompare(b.logId)
                    : a.blockNumber < b.blockNumber ? -1 : 1,
            );
    }

    /**
     * Live-watch `StateCommitted` for one publisher. Returns an unsubscribe
     * function. Uses the client's transport (polling over HTTP, push over a
     * WebSocket transport) — reads logs straight from the RPC node, no subgraph.
     */
    watchStateCommitted(
        publisher: Address,
        onCommit: (log: StateCommittedLog) => void,
        onError?: (err: Error) => void,
        pollingInterval?: number,
    ): () => void {
        return this.publicClient.watchContractEvent({
            address: this.contractAddress,
            abi: DATA_REGISTRY_ABI,
            eventName: "StateCommitted",
            args: { publisher },
            pollingInterval,
            onLogs: (logs) => {
                for (const log of logs) onCommit(decodeStateCommitted(log));
            },
            onError,
        });
    }

    async publisherCount(): Promise<bigint> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: DATA_REGISTRY_ABI,
            functionName: "publisherCount",
        }) as Promise<bigint>;
    }

    async registrationFee(): Promise<bigint> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: DATA_REGISTRY_ABI,
            functionName: "registrationFee",
        }) as Promise<bigint>;
    }

    async admin(): Promise<Address> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: DATA_REGISTRY_ABI,
            functionName: "admin",
        }) as Promise<Address>;
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