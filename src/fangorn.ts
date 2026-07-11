import {
    createPublicClient,
    createWalletClient,
    http,
    type Hex,
    type PublicClient,
    type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CID } from "multiformats/cid";

import { AppConfig, FangornConfig } from "./config.js";
import { FangornContext, FangornCreateOptions, StorageConfig } from "./types/index.js";
import { MetadataStorage } from "./providers/storage/types.js";
import { PinataBackend } from "./providers/storage/pinata.js";
import { FangornEngine, MetagraphRegistry, NamespaceContents, NamespaceDiff } from "./engine/index.js";
import { StorageBlockstoreAdapter } from "./engine/blockstore.js";
import { DataRegistryClient, StateCommittedLog } from "./contracts/index.js";

const ZERO_BYTES32: Hex = "0x0000000000000000000000000000000000000000000000000000000000000000";

/** One namespace-scoped update surfaced by `subscribe`. */
export interface NamespaceChange extends NamespaceDiff {
    namespace: string;
    owner: Hex;
    /** The commit CID (string) this update settled to — the new on-chain tip. */
    commitCid: string;
    /** Raw on-chain roots this delta spans (`oldRoot` → `newRoot`). */
    oldRoot: Hex;
    newRoot: Hex;
    /** Block the `StateCommitted` event landed in — persist as the resume cursor. */
    blockNumber: bigint;
}

export interface SubscribeOptions {
    namespace: string;
    /** Publisher whose root to watch (defaults to this wallet's address). */
    owner?: Hex;
    /**
     * Replay `StateCommitted` events from this block before going live (the resume
     * cursor). Omit to start live from the current chain tip — seed initial state
     * separately via `inspectNamespace`.
     */
    fromBlock?: bigint;
    /** Poll interval (ms) for the live watch over an HTTP transport. */
    pollingInterval?: number;
    /** Abort to stop the subscription and release the watch. */
    signal?: AbortSignal;
}

function isPinataConfig(s: StorageConfig): s is { pinata: { jwt: string; gateway: string } } {
    return "pinata" in (s as object);
}

function resolveStorage(storage?: StorageConfig): MetadataStorage | undefined {
    if (!storage) return undefined;
    if (isPinataConfig(storage)) return new PinataBackend(storage.pinata.jwt, storage.pinata.gateway);
    throw new Error(`Invalid storage config: must be { pinata: { jwt, gateway } }, got ${JSON.stringify(storage)}`);
}

export class Fangorn {
    private readonly ctx: FangornContext;
    private _engine: FangornEngine | null = null;
    private _metagraph: MetagraphRegistry | null = null;

    private constructor(ctx: FangornContext) {
        this.ctx = ctx;
    }

    get engine(): FangornEngine {
        if (!this.ctx.metadataStorage) {
            throw new Error("fangorn.engine requires storage configurations. Pass { pinata: { ... } } to Fangorn.create()");
        }
        if (!this._engine) {
            const blockstoreAdapter = new StorageBlockstoreAdapter(this.ctx.metadataStorage);
            this._metagraph = new MetagraphRegistry();

            this._engine = new FangornEngine(
                blockstoreAdapter as any,
                this._metagraph,
                this.ctx.dataRegistry
            );
        }
        return this._engine;
    }

    get metagraph(): MetagraphRegistry {
        const _ = this.engine;
        return this._metagraph!;
    }

    static create(options: FangornCreateOptions): Fangorn {
        if (!options.privateKey && !options.walletClient) {
            throw new Error("Either privateKey or walletClient must be provided");
        }

        const resolvedConfig = options.config ?? FangornConfig;

        const walletClient = options.walletClient ?? createWalletClient({
            account: privateKeyToAccount(options.privateKey ?? "0x0"),
            chain: resolvedConfig.chain,
            transport: http(resolvedConfig.rpcUrl),
        });

        const metadataStorage = resolveStorage(options.storage);
        const domain = options.domain ?? new URL(resolvedConfig.rpcUrl).hostname;

        const publicClient = createPublicClient({
            transport: http(resolvedConfig.rpcUrl),
        }) as PublicClient;

        const dataRegistry = new DataRegistryClient(
            resolvedConfig.dataRegistryContractAddress,
            publicClient,
            walletClient,
        );

        return new Fangorn({
            walletClient,
            metadataStorage,
            domain,
            dataRegistry: dataRegistry as any,
            config: resolvedConfig,
        });
    }

    // resets the onchain state root to zero
    // use at your own risk
    async reset() {
        const registry = this.getDataRegistry();
        const currentRoot = await registry.getNamespaceHead(this.getAddress());
        await registry.commitStateRoot(currentRoot, ZERO_BYTES32);
    }

    /**
     * Allocates a namespace key directly within the transactional Pail index tree.
     * A no-op (no on-chain tx) if the namespace is already initialized, so callers
     * can call this unconditionally before every publish.
     */
    async initRepo(repoName: string) {
        const publisher = this.getAddress();

        if (await this.engine.namespaceExists(repoName, publisher)) {
            return { cid: undefined, commitCid: undefined, txHash: undefined, alreadyInitialized: true as const };
        }

        // Continue the publisher's on-chain history and open the namespace by
        // planting its `sys/init` marker inside the pail tree.
        const { batch, baseCommitCid } = await this.engine.createBatch(publisher);
        await batch.put(`${repoName}/sys/init`, "initialized");

        console.log(`[Fangorn] Committing repository '${repoName}'`);

        const { commitCid } = await this.engine.sealBatch(
            batch,
            baseCommitCid ? [baseCommitCid] : [],
            `Initialize repository workspace: ${repoName}`
        );
        const { txHash } = await this.engine.pushCommit(publisher, commitCid);

        return {
            cid: commitCid.toString(),
            commitCid: commitCid.toString(),
            txHash,
            alreadyInitialized: false as const,
        };
    }

    /**
     * Stages a node payload against structural metadata rules inside the Pail collection context.
     */
    async upload(repoName: string, payload: any, schemaId: string) {
        const publisher = this.getAddress();
        const { batch, contractHeadHex, baseCommitCid } = await this.engine.createBatch(publisher);
        // can't upload to a zero-state chain.
        if (contractHeadHex === ZERO_BYTES32) {
            throw new Error(`Repository '${repoName}' does not exist. Call initRepo() prior to uploading.`);
        }

        // No schema registry anymore — schemaId is a free-form tag. Register it
        // permissively (no required fields) unless the caller has already
        // registered stricter rules via this.metagraph directly.
        if (!this.metagraph.hasVertexSchema(repoName, schemaId)) {
            this.metagraph.registerVertex(repoName, { id: schemaId, requiredFields: [] });
        }

        console.log(`[Fangorn] Staging vertex to repository workspace...`);
        const vertexCidString = await this.engine.stageVertex(batch, repoName, schemaId, payload);

        const { commitCid } = await this.engine.sealBatch(
            batch,
            baseCommitCid ? [baseCommitCid] : [],
            `Upload to namespace ${repoName} under schema ${schemaId}`
        );
        const { txHash } = await this.engine.pushCommit(publisher, commitCid);

        return {
            payloadCid: vertexCidString,
            commitCid: commitCid.toString(),
            txHash
        };
    }

    /**
     * Stages vertices (and edges resolved by local id) into a namespace against an
     * already-open batch. Shared by the immediate `uploadBatch` path and the git
     * `commit` path. Returns the local-id → staged-CID map.
     */
    private async stageGraph(
        batch: any,
        repoName: string,
        vertices: { id: string; tag: string; payload: any }[],
        edges: { rel: string; from: string; to: string }[],
    ): Promise<Map<string, string>> {
        const idToCid = new Map<string, string>();
        const idToTag = new Map<string, string>();
        for (const v of vertices) {
            if (!this.metagraph.hasVertexSchema(repoName, v.tag)) {
                this.metagraph.registerVertex(repoName, { id: v.tag, requiredFields: [] });
            }
            const cid = await this.engine.stageVertex(batch, repoName, v.tag, v.payload);
            idToCid.set(v.id, cid);
            idToTag.set(v.id, v.tag);
        }

        for (const e of edges) {
            const sourceCid = idToCid.get(e.from);
            const targetCid = idToCid.get(e.to);
            const sourceTag = idToTag.get(e.from);
            const targetTag = idToTag.get(e.to);
            if (!sourceCid || !targetCid || !sourceTag || !targetTag) {
                throw new Error(`edge references unknown local id (from=${e.from}, to=${e.to})`);
            }
            if (!this.metagraph.hasEdgeSchema(repoName, sourceTag, e.rel, targetTag)) {
                this.metagraph.registerEdge(repoName, { sourceSchema: sourceTag, relation: e.rel, targetSchema: targetTag });
            }
            await this.engine.stageEdge(batch, repoName, { sourceCid, relation: e.rel, targetCid }, sourceTag, targetTag);
        }

        return idToCid;
    }

    /**
     * Stages many vertices (and optionally edges between them) in a single
     * on-chain commit, instead of one tx per vertex. Edges reference vertices by
     * the caller-supplied local `id`, resolved to their staged CID before staging.
     */
    async uploadBatch(
        repoName: string,
        vertices: { id: string; tag: string; payload: any }[],
        edges: { rel: string; from: string; to: string }[] = [],
    ) {
        const publisher = this.getAddress();
        const { batch, contractHeadHex, baseCommitCid } = await this.engine.createBatch(publisher);
        if (contractHeadHex === ZERO_BYTES32) {
            throw new Error(`Repository '${repoName}' does not exist. Call initRepo() prior to uploading.`);
        }

        const idToCid = await this.stageGraph(batch, repoName, vertices, edges);

        const { commitCid } = await this.engine.sealBatch(
            batch,
            baseCommitCid ? [baseCommitCid] : [],
            `Batch upload to namespace ${repoName}: ${vertices.length.toString()} vertices, ${edges.length.toString()} edges`
        );
        const { txHash } = await this.engine.pushCommit(publisher, commitCid);

        return {
            commitCid: commitCid.toString(),
            txHash,
            vertexCids: Object.fromEntries(idToCid),
        };
    }

    // ── Git-native flow: local commit → push, plus history/diff/clone ──────────
    //
    // These decouple the pail write from the on-chain settle. `commit` snapshots
    // data into a new commit object (durable in storage, but the on-chain head is
    // untouched — like writing to `.git/objects`); `push` fast-forwards the
    // on-chain head to a local commit (the permissioned ref update).

    /**
     * Build a new commit locally (no on-chain tx) that stages vertices/edges into
     * `namespace` on top of `parent` (a commit CID string, or undefined for a root
     * commit). Blocks are flushed to storage so a later `push` — even in a separate
     * process — can settle it.
     */
    async commit(opts: {
        namespace: string;
        vertices?: { id: string; tag: string; payload: any }[];
        edges?: { rel: string; from: string; to: string }[];
        parent?: string;
        message: string;
    }): Promise<{ commitCid: string; parents: string[]; pailRoot: string; vertexCids: Record<string, string> }> {
        const parentCid = opts.parent ? CID.parse(opts.parent) : null;
        const basePailRoot = parentCid ? (await this.engine.getCommit(parentCid)).pailRoot : null;
        const batch = await this.engine.openBatch(basePailRoot);

        // A root commit opens the namespace with its marker; later commits inherit it.
        if (!parentCid) {
            await batch.put(`${opts.namespace}/sys/init`, "initialized");
        }

        const idToCid = await this.stageGraph(batch, opts.namespace, opts.vertices ?? [], opts.edges ?? []);
        const { commitCid, pailRoot } = await this.engine.sealBatch(
            batch,
            parentCid ? [parentCid] : [],
            opts.message,
        );
        await this.engine.flush();

        return {
            commitCid: commitCid.toString(),
            parents: parentCid ? [parentCid.toString()] : [],
            pailRoot: pailRoot.toString(),
            vertexCids: Object.fromEntries(idToCid),
        };
    }

    /** Settle a local commit as the on-chain head (fast-forward unless `force`). */
    async push(commitCid: string, opts?: { force?: boolean }): Promise<{ txHash: string; onChainTip: string }> {
        const { txHash, onChainTip } = await this.engine.pushCommit(this.getAddress(), CID.parse(commitCid), opts);
        return { txHash, onChainTip: onChainTip.toString() };
    }

    /** The owner's current on-chain tip commit CID, or null if they have no commits. */
    async onChainTip(owner: Hex): Promise<string | null> {
        const cid = await this.engine.resolveHeadCommit(owner);
        return cid ? cid.toString() : null;
    }

    /** Walk commit history from `head` (newest first). */
    async *log(head: string, max?: number): AsyncGenerator<{ cid: string; parents: string[]; timestamp: number; message: string; pailRoot: string }> {
        for await (const { cid, commit } of this.engine.walkParents(CID.parse(head), max)) {
            yield {
                cid: cid.toString(),
                parents: (commit.parents as CID[]).map(c => c.toString()),
                timestamp: commit.timestamp,
                message: commit.message,
                pailRoot: commit.pailRoot.toString(),
            };
        }
    }

    /** Show a commit and what it changed vs. its first parent. */
    async show(commitCid: string) {
        return this.engine.diffCommit(CID.parse(commitCid));
    }

    /**
     * Lists every vertex and edge currently committed under a namespace, resolved
     * from the publisher's on-chain root — useful for verifying what actually
     * made it into the repository, as opposed to what a given call staged.
     */
    async inspectNamespace(repoName: string): Promise<NamespaceContents> {
        return this.engine.listNamespace(repoName, this.getAddress());
    }

    // ── Subscription: a light client for an owned namespace ────────────────────
    //
    // A publisher owns exactly one on-chain root; namespaces are key-prefixes
    // inside its Pail tree, so the registry's `StateCommitted(publisher, old, new)`
    // event is per-publisher, not per-namespace. Subscribing therefore means:
    // watch that owner's event, and for each new root diff the tree against the
    // previous root restricted to the `<namespace>/` prefix — emitting only when
    // that slice actually changed. Reads logs straight from the RPC node and
    // resolves diffs from content-addressed storage: no subgraph, no indexer.

    /**
     * Stream namespace-scoped changes as the on-chain root advances. Optionally
     * replays from `fromBlock` first (resume cursor), then watches live until the
     * `signal` aborts. Each yielded change carries `blockNumber` — persist it to
     * resume exactly where you left off.
     */
    async *subscribe(opts: SubscribeOptions): AsyncGenerator<NamespaceChange> {
        const owner = opts.owner ?? this.getAddress();
        const ns = opts.namespace;
        const registry = this.getDataRegistry();

        // Dedupe across the catch-up (getLogs) and live (watch) paths, which can
        // overlap around the current tip.
        const seen = new Set<string>();

        // Live events buffer here from the moment we subscribe, so nothing emitted
        // during catch-up is lost.
        const buffer: StateCommittedLog[] = [];
        let wake: (() => void) | null = null;
        let failure: Error | null = null;
        let stopped = false;
        const signal = () => { const w = wake; wake = null; w?.(); };

        const unwatch = registry.watchStateCommitted(
            owner,
            (log) => { buffer.push(log); signal(); },
            (err) => { failure = err; signal(); },
            opts.pollingInterval,
        );

        const onAbort = () => { stopped = true; signal(); };
        opts.signal?.addEventListener("abort", onAbort);

        try {
            if (opts.fromBlock !== undefined) {
                for (const log of await registry.getStateCommittedLogs(owner, opts.fromBlock)) {
                    if (seen.has(log.logId)) continue;
                    seen.add(log.logId);
                    const change = await this.toNamespaceChange(log, ns, owner);
                    if (change) yield change;
                }
            }

            while (!stopped) {
                if (failure) throw failure;
                if (buffer.length === 0) {
                    await new Promise<void>((res) => { wake = res; });
                    continue;
                }
                const log = buffer.shift()!;
                if (seen.has(log.logId)) continue;
                seen.add(log.logId);
                const change = await this.toNamespaceChange(log, ns, owner);
                if (change) yield change;
            }
        } finally {
            unwatch();
            opts.signal?.removeEventListener("abort", onAbort);
        }
    }

    /** Resolve a raw `StateCommitted` log into a namespace change, or null if the namespace slice was untouched. */
    private async toNamespaceChange(log: StateCommittedLog, namespace: string, owner: Hex): Promise<NamespaceChange | null> {
        const diff = await this.engine.namespaceDiff(
            log.oldRoot === ZERO_BYTES32 ? null : log.oldRoot,
            log.newRoot,
            namespace,
        );
        const touched =
            diff.addedVertices.length || diff.removedVertexCids.length ||
            diff.addedEdges.length || diff.removedEdges.length;
        if (!touched) return null;

        return {
            namespace,
            owner,
            commitCid: this.engine.commitCidFromRootHex(log.newRoot),
            oldRoot: log.oldRoot,
            newRoot: log.newRoot,
            blockNumber: log.blockNumber,
            ...diff,
        };
    }

    getConfig(): AppConfig { return this.ctx.config; }

    getDataRegistry(): DataRegistryClient { return this.ctx.dataRegistry as any; }

    getStorage(): MetadataStorage {
        if (!this.ctx.metadataStorage) {
            throw new Error("storage is not configured. Pass { pinata: { ... } } to Fangorn.create()");
        }
        return this.ctx.metadataStorage;
    }

    getWalletClient(): WalletClient { return this.ctx.walletClient; }

    getAddress(): Hex {
        const address = this.ctx.walletClient.account?.address;
        if (!address) throw new Error("No account connected to wallet client");
        return address;
    }
}