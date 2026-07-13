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
import {
	FangornContext,
	FangornCreateOptions,
	StorageConfig,
} from "./types/index.js";
import { MetadataStorage } from "./providers/storage/types.js";
import { PinataBackend } from "./providers/storage/pinata.js";
import {
	assertValidNamespace,
	FangornEngine,
	MetagraphRegistry,
	NamespaceContents,
	NamespaceDiff,
} from "./engine/index.js";
import { DataRegistryClient, StateCommittedLog } from "./contracts/index.js";

const ZERO_BYTES32: Hex =
	"0x0000000000000000000000000000000000000000000000000000000000000000";

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

function isPinataConfig(
	s: StorageConfig,
): s is { pinata: { jwt: string; gateway: string } } {
	return "pinata" in (s as object);
}

function resolveStorage(storage?: StorageConfig): MetadataStorage | undefined {
	if (!storage) return undefined;
	if (isPinataConfig(storage))
		return new PinataBackend(storage.pinata.jwt, storage.pinata.gateway);
	throw new Error(
		`Invalid storage config: must be { pinata: { jwt, gateway } }, got ${JSON.stringify(storage)}`,
	);
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
			throw new Error(
				"fangorn.engine requires storage configurations. Pass { pinata: { ... } } to Fangorn.create()",
			);
		}
		if (!this._engine) {
			this._metagraph = new MetagraphRegistry();

			this._engine = new FangornEngine(
				this.ctx.metadataStorage,
				this._metagraph,
				this.ctx.dataRegistry,
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

		const walletClient =
			options.walletClient ??
			createWalletClient({
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
	 * Register permissive (no required fields) schemas for every tag/relation a
	 * staged graph uses, unless the caller has already registered stricter rules
	 * via `this.metagraph` directly — schema ids are free-form tags by default.
	 */
	private registerPermissiveSchemas(
		repoName: string,
		vertices: { id: string; tag: string; payload: any }[],
		edges: { rel: string; from: string; to: string }[],
	): void {
		const tagOf = new Map<string, string>();
		for (const v of vertices) {
			tagOf.set(v.id, v.tag);
			if (!this.metagraph.hasVertexSchema(repoName, v.tag)) {
				this.metagraph.registerVertex(repoName, {
					id: v.tag,
					requiredFields: [],
				});
			}
		}
		for (const e of edges) {
			const sourceTag = tagOf.get(e.from);
			const targetTag = tagOf.get(e.to);
			if (!sourceTag || !targetTag) continue; // createCommit reports the missing id
			if (
				!this.metagraph.hasEdgeSchema(repoName, sourceTag, e.rel, targetTag)
			) {
				this.metagraph.registerEdge(repoName, {
					sourceSchema: sourceTag,
					relation: e.rel,
					targetSchema: targetTag,
				});
			}
		}
	}

	/** Stage a graph into one commit on top of `base` (engine shapes adapted from CLI shapes). */
	private createCommit(opts: {
		namespace: string;
		base: CID | null;
		vertices: { id: string; tag: string; payload: any }[];
		edges: { rel: string; from: string; to: string }[];
		message: string;
		replace?: boolean;
	}) {
		this.registerPermissiveSchemas(opts.namespace, opts.vertices, opts.edges);
		return this.engine.createCommit({
			namespace: opts.namespace,
			base: opts.base,
			vertices: opts.vertices.map((v) => ({
				id: v.id,
				schemaId: v.tag,
				payload: v.payload,
			})),
			edges: opts.edges.map((e) => ({
				relation: e.rel,
				from: e.from,
				to: e.to,
			})),
			message: opts.message,
			replace: opts.replace,
		});
	}

	/**
	 * Allocates a namespace in the publisher's root map. A no-op (no on-chain tx)
	 * if the namespace is already initialized, so callers can call this
	 * unconditionally before every publish.
	 */
	async initRepo(repoName: string) {
		assertValidNamespace(repoName);
		const publisher = this.getAddress();

		if (await this.engine.namespaceExists(repoName, publisher)) {
			return {
				cid: undefined,
				commitCid: undefined,
				txHash: undefined,
				alreadyInitialized: true as const,
			};
		}

		// Continue the publisher's on-chain history with a commit that adds the
		// namespace (as an empty tree) to the root map.
		const head = await this.engine.resolveHeadCommit(publisher);
		const { commitCid } = await this.createCommit({
			namespace: repoName,
			base: head,
			vertices: [],
			edges: [],
			message: `Initialize repository workspace: ${repoName}`,
		});
		const { txHash } = await this.engine.pushCommit(publisher, commitCid);

		return {
			cid: commitCid.toString(),
			commitCid: commitCid.toString(),
			txHash,
			alreadyInitialized: false as const,
		};
	}

	/**
	 * Stage one vertex and settle it on-chain in a single shot.
	 */
	async upload(repoName: string, payload: any, schemaId: string) {
		const publisher = this.getAddress();
		const head = await this.engine.resolveHeadCommit(publisher);
		// can't upload to a zero-state chain.
		if (!head) {
			throw new Error(
				`Repository '${repoName}' does not exist. Call initRepo() prior to uploading.`,
			);
		}

		const { commitCid, vertexCids } = await this.createCommit({
			namespace: repoName,
			base: head,
			vertices: [{ id: "v0", tag: schemaId, payload }],
			edges: [],
			message: `Upload to namespace ${repoName} under schema ${schemaId}`,
		});
		const { txHash } = await this.engine.pushCommit(publisher, commitCid);

		return {
			payloadCid: vertexCids["v0"],
			commitCid: commitCid.toString(),
			txHash,
		};
	}

	/**
	 * Stages many vertices (and optionally edges between them) under one publisher
	 * root, instead of one tx per vertex. The whole graph is built in memory and
	 * persisted as ONE CAR upload plus one commit block, then settled in a single
	 * fast-forward tx. Edges reference vertices by the caller-supplied local `id`.
	 */
	async uploadBatch(
		repoName: string,
		vertices: { id: string; tag: string; payload: any }[],
		edges: { rel: string; from: string; to: string }[] = [],
	) {
		assertValidNamespace(repoName);
		if (vertices.length === 0 && edges.length === 0) {
			throw new Error("uploadBatch requires at least one vertex or edge");
		}

		const publisher = this.getAddress();
		const head = await this.engine.resolveHeadCommit(publisher);
		if (!head) {
			throw new Error(
				`Repository '${repoName}' does not exist. Call initRepo() prior to uploading.`,
			);
		}

		const { commitCid, vertexCids } = await this.createCommit({
			namespace: repoName,
			base: head,
			vertices,
			edges,
			message: `Batch upload to namespace ${repoName}`,
		});

		const { txHash } = await this.engine.pushCommit(publisher, commitCid);

		return {
			commitCid: commitCid.toString(),
			txHash,
			vertexCids,
		};
	}

	// ── Git-native flow: local commit → push, plus history/diff/clone ──────────
	//
	// These decouple building state from the on-chain settle. `commit` snapshots
	// data into a new commit object (durable in storage, but the on-chain head is
	// untouched — like writing to `.git/objects`); `push` fast-forwards the
	// on-chain head to a local commit (the permissioned ref update).

	/**
	 * Build a new commit (no on-chain tx) that stages vertices/edges into
	 * `namespace` on top of `parent` (a commit CID string, or undefined for a
	 * root commit). The commit and its CAR are uploaded to storage, so a later
	 * `push` — even in a separate process — can settle it.
	 */
	async commit(opts: {
		namespace: string;
		vertices?: { id: string; tag: string; payload: any }[];
		edges?: { rel: string; from: string; to: string }[];
		parent?: string;
		message: string;
		/** Snapshot semantics: the staged graph replaces the namespace's previous contents. */
		replace?: boolean;
	}): Promise<{
		commitCid: string;
		parents: string[];
		root: string;
		vertexCids: Record<string, string>;
	}> {
		assertValidNamespace(opts.namespace);
		const parentCid = opts.parent ? CID.parse(opts.parent) : null;

		const { commitCid, root, vertexCids } = await this.createCommit({
			namespace: opts.namespace,
			base: parentCid,
			vertices: opts.vertices ?? [],
			edges: opts.edges ?? [],
			message: opts.message,
			replace: opts.replace,
		});

		return {
			commitCid: commitCid.toString(),
			parents: parentCid ? [parentCid.toString()] : [],
			root: root.toString(),
			vertexCids,
		};
	}

	/** Settle a local commit as the on-chain head (fast-forward unless `force`). */
	async push(
		commitCid: string,
		opts?: { force?: boolean },
	): Promise<{ txHash: string; onChainTip: string }> {
		const { txHash, onChainTip } = await this.engine.pushCommit(
			this.getAddress(),
			CID.parse(commitCid),
			opts,
		);
		return { txHash, onChainTip: onChainTip.toString() };
	}

	/** The owner's current on-chain tip commit CID, or null if they have no commits. */
	async onChainTip(owner: Hex): Promise<string | null> {
		const cid = await this.engine.resolveHeadCommit(owner);
		return cid ? cid.toString() : null;
	}

	/** Walk commit history from `head` (newest first). */
	async *log(
		head: string,
		max?: number,
	): AsyncGenerator<{
		cid: string;
		parents: string[];
		timestamp: number;
		message: string;
		root: string;
	}> {
		for await (const { cid, commit } of this.engine.walkParents(
			CID.parse(head),
			max,
		)) {
			yield {
				cid: cid.toString(),
				parents: commit.parents.map((c) => c.toString()),
				timestamp: commit.timestamp,
				message: commit.message,
				root: commit.root.toString(),
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
	// A publisher owns exactly one on-chain root; namespaces are entries in its
	// root map, so the registry's `StateCommitted(publisher, old, new)` event is
	// per-publisher, not per-namespace. Subscribing therefore means: watch that
	// owner's event, and for each new root diff the namespace's link sets against
	// the previous root — emitting only when that slice actually changed. Reads
	// logs straight from the RPC node and resolves diffs from content-addressed
	// storage (one CAR download per push): no subgraph, no indexer.

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
		const signal = () => {
			const w = wake;
			wake = null;
			w?.();
		};

		const unwatch = registry.watchStateCommitted(
			owner,
			(log) => {
				buffer.push(log);
				signal();
			},
			(err) => {
				failure = err;
				signal();
			},
			opts.pollingInterval,
		);

		const onAbort = () => {
			stopped = true;
			signal();
		};
		opts.signal?.addEventListener("abort", onAbort);

		try {
			if (opts.fromBlock !== undefined) {
				for (const log of await registry.getStateCommittedLogs(
					owner,
					opts.fromBlock,
				)) {
					if (seen.has(log.logId)) continue;
					seen.add(log.logId);
					const change = await this.toNamespaceChange(log, ns, owner);
					if (change) yield change;
				}
			}

			while (!stopped) {
				if (failure) throw failure;
				if (buffer.length === 0) {
					await new Promise<void>((res) => {
						wake = res;
					});
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
	private async toNamespaceChange(
		log: StateCommittedLog,
		namespace: string,
		owner: Hex,
	): Promise<NamespaceChange | null> {
		const diff = await this.engine.namespaceDiff(
			log.oldRoot === ZERO_BYTES32 ? null : log.oldRoot,
			log.newRoot,
			namespace,
		);
		const touched =
			diff.addedVertices.length ||
			diff.removedVertexCids.length ||
			diff.addedEdges.length ||
			diff.removedEdges.length;
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

	getConfig(): AppConfig {
		return this.ctx.config;
	}

	getDataRegistry(): DataRegistryClient {
		return this.ctx.dataRegistry as any;
	}

	getStorage(): MetadataStorage {
		if (!this.ctx.metadataStorage) {
			throw new Error(
				"storage is not configured. Pass { pinata: { ... } } to Fangorn.create()",
			);
		}
		return this.ctx.metadataStorage;
	}

	getWalletClient(): WalletClient {
		return this.ctx.walletClient;
	}

	getAddress(): Hex {
		const address = this.ctx.walletClient.account?.address;
		if (!address) throw new Error("No account connected to wallet client");
		return address;
	}
}
