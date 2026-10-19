import {
    GetContractEventsReturnType,
    concatHex,
    keccak256,
    toHex,
    type Address,
    type Hex,
    type PublicClient,
} from "viem";

import { DATA_REGISTRY_ABI } from "./abi.js";
import { getLogsInWindows } from "../logs.js";

/**
 * The onchain id of a namespace within an app is the sha256 hash of its hex representation
 * i.e. ns = 'a' => ns_id = sha256(hex('a'))
 */
export function subspaceId(namespace: string): Hex {
    return keccak256(toHex(namespace));
}

/**
 * The composite storage key for a full path to a subspace: `app:publisher:subspace`.
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

/**
 * The state-root timeline: namespace heads and their `StateCommitted` logs. Read
 * only — commits go through {@link AppRegistryClient.commitStateRoot}, which checks
 * the publisher may publish and forwards them here; this contract accepts commits
 * from the AppRegistry alone.
 */
export class DataRegistryClient {
    constructor(
        private contractAddress: Address,
        private appId: Hex,
        private publicClient: PublicClient,
    ) { }

    /** The app namespace every call on this client is scoped to. */
    getAppId(): Hex {
        return this.appId;
    }

    /** Re-scope every subsequent call to a different app. See `Fangorn.setAppId`. */
    setAppId(appId: Hex): void {
        this.appId = appId;
    }

    /** The deployed DataRegistry this client talks to. */
    getAddress(): Address {
        return this.contractAddress;
    }

    /** The composite key for one of this app's namespaces. */
    namespaceKey(publisher: Address, namespace: string): Hex {
        return namespaceKey(this.appId, publisher, subspaceId(namespace));
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

    /** The AppRegistry: the only caller this contract takes commits from. */
    async appRegistry(): Promise<Address> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: DATA_REGISTRY_ABI,
            functionName: "appRegistry",
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
     * Fetched in block windows (see `getLogsInWindows`).
     */
    async getStateCommittedLogs(
        filter: CommitFilter,
        fromBlock: bigint,
        toBlock?: bigint,
    ): Promise<StateCommittedLog[]> {
        const logs = await getLogsInWindows(this.publicClient, fromBlock, toBlock, (from, to) =>
            this.publicClient.getContractEvents({
                address: this.contractAddress,
                abi: DATA_REGISTRY_ABI,
                eventName: "StateCommitted",
                args: this.topicsFor(filter),
                fromBlock: from,
                toBlock: to,
            }),
        );
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

    async admin(): Promise<Address> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: DATA_REGISTRY_ABI,
            functionName: "admin",
        });
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
