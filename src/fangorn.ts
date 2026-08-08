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

import { AppConfig, DEFAULT_APP, FangornConfig, toAppId } from "./config.js";
import {
	FangornContext,
	FangornCreateOptions,
	StorageConfig,
} from "./types/index.js";
import { MetadataStorage } from "./providers/storage/types.js";
import { PinataBackend } from "./providers/storage/pinata.js";
import {
	SignedUrlBackend,
	SignedUrlSigner,
} from "./providers/storage/signed-url.js";
import {
	assertValidNamespace,
	FangornEngine,
	MetagraphRegistry,
	NamespaceContents,
	NamespaceDiff,
	rootHexFromCid,
} from "./engine/index.js";
import {
	CommitFilter,
	DataRegistryClient,
	PreparedTx,
	StateCommittedLog,
	subspaceId,
} from "./contracts/index.js";
import { AppFeed } from "./feed.js";

const ZERO_BYTES32: Hex =
	"0x0000000000000000000000000000000000000000000000000000000000000000";

/** Max namespaces held in TODO
 *  `readNamespace`'s tip-keyed cache. */
const NS_CACHE_MAX = 256;

/** One namespace-scoped update surfaced by `subscribe`. */
// TODO
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
	/** Publisher whose namespace to watch (defaults to this wallet's address). */
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

/** Build a signer for the access worker's ownership handshake from a wallet. */
function walletSigner(walletClient: WalletClient): SignedUrlSigner {
	const account = walletClient.account;
	if (!account) {
		throw new Error(
			"Signed-url storage requires a wallet account to sign the access worker's challenge.",
		);
	}
	return {
		address: account.address,
		signMessage: (message) => walletClient.signMessage({ account, message }),
	};
}

function resolveStorage(
	storage: StorageConfig | undefined,
	walletClient: WalletClient,
	config: AppConfig,
): MetadataStorage | undefined {
	if (!storage) return undefined;
	if ("pinata" in storage)
		return new PinataBackend(storage.pinata.jwt, storage.pinata.gateway);
	if ("signedUrl" in storage)
		return new SignedUrlBackend(
			storage.signedUrl.workerUrl,
			walletSigner(walletClient),
			storage.signedUrl.gateway ?? config.ipfsGateway,
		);
	throw new Error(
		`Invalid storage config: must be { pinata: … } or { signedUrl: … }, got ${JSON.stringify(storage)}`,
	);
}

export class Fangorn {

	private readonly ctx: FangornContext;

	private _engine: FangornEngine | null = null;

	private readonly _metagraph = new MetagraphRegistry();

	private _feed: AppFeed | null = null;

	/** 
	 * The namespace cache
	 * Insertion order = LRU order; see `readNamespace`. 
	 */
	private readonly nsCache = new Map<
		string,
		{ tip: string | null; contents: NamespaceContents }
	>();

	private constructor(ctx: FangornContext) {
		this.ctx = ctx;
	}

	get engine(): FangornEngine {
		if (!this.ctx.metadataStorage) {
			throw new Error(
				"fangorn.engine requires storage configurations. Pass { pinata: { ... } } to Fangorn.create()",
			);
		}

		this._engine ??= new FangornEngine(
			this.ctx.metadataStorage,
			this._metagraph,
			this.ctx.dataRegistry,
		);
		return this._engine;
	}

	get metagraph(): MetagraphRegistry {
		return this._metagraph;
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

		const metadataStorage = resolveStorage(
			options.storage,
			walletClient,
			resolvedConfig,
		);
		const domain = options.domain ?? new URL(resolvedConfig.rpcUrl).hostname;

		const publicClient = createPublicClient({
			transport: http(resolvedConfig.rpcUrl),
		}) as PublicClient;

		const dataRegistry = new DataRegistryClient(
			resolvedConfig.dataRegistryContractAddress,
			toAppId(options.appId ?? DEFAULT_APP),
			publicClient,
			walletClient,
		);

		return new Fangorn({
			walletClient,
			metadataStorage,
			domain,
			dataRegistry: dataRegistry,
			config: resolvedConfig,
		});
	}

	/**
	 * Resets a namespace's onchain state root to zero.
	 * TODO: also unpin all data
	 * Use at your own risk.
	*/ 
	async reset(namespace: string) {
		const registry = this.getDataRegistry();
		const currentRoot = await registry.getNamespaceHead(
			this.getAddress(),
			namespace,
		);
		await registry.commitStateRoot(namespace, currentRoot, ZERO_BYTES32);
	}

	/**
	 * Register permissive (no required fields) schemas for every tag/relation a
	 * staged graph uses, unless the caller has already registered stricter rules
	 * via `this.metagraph` directly — schema ids are free-form tags by default.
	 */
	private registerPermissiveSchemas(
		repoName: string,
		vertices: { id: string; tag: string; payload: unknown }[],
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
			// createCommit reports the missing id
			if (!sourceTag || !targetTag) continue;
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
		vertices: { id: string; tag: string; payload: unknown }[];
		edges: { rel: string; from: string; to: string }[];
		message: string;
		replace?: boolean;
	}) {
		this.registerPermissiveSchemas(opts.namespace, opts.vertices, opts.edges);
		return this.engine.createCommit({
			namespace: opts.namespace,
			base: opts.base,
			vertices: opts.vertices.map((v) => {
				// Safely ensure payload conforms to Record<string, unknown>
				const safePayload = (v.payload && typeof v.payload === "object" && !Array.isArray(v.payload))
					? (v.payload as Record<string, unknown>)
					: { value: v.payload }; // fallback structure for primitives or arrays

				return {
					id: v.id,
					schemaId: v.tag,
					payload: safePayload,
				};
			}),
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
	 * Allocates a namespace in the publisher's root map. 
	 * A no-op (no on-chain tx) if the namespace is already initialized.
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
		const head = await this.engine.resolveHeadCommit(publisher, repoName);
		const { commitCid } = await this.createCommit({
			namespace: repoName,
			base: head,
			vertices: [],
			edges: [],
			message: `Initialize repository workspace: ${repoName}`,
		});
		const { txHash } = await this.engine.pushCommit(
			publisher,
			repoName,
			commitCid,
		);

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
	async upload(repoName: string, payload: unknown, schemaId: string) {
		const publisher = this.getAddress();
		const head = await this.engine.resolveHeadCommit(publisher, repoName);
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
		const { txHash } = await this.engine.pushCommit(
			publisher,
			repoName,
			commitCid,
		);

		return {
			payloadCid: vertexCids.v0,
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
		vertices: { id: string; tag: string; payload: unknown }[],
		edges: { rel: string; from: string; to: string }[] = [],
	) {
		assertValidNamespace(repoName);
		if (vertices.length === 0 && edges.length === 0) {
			throw new Error("uploadBatch requires at least one vertex or edge");
		}

		const publisher = this.getAddress();
		const head = await this.engine.resolveHeadCommit(publisher, repoName);
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

		const { txHash } = await this.engine.pushCommit(
			publisher,
			repoName,
			commitCid,
		);

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
		vertices?: { id: string; tag: string; payload: unknown }[];
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

	/**
	 * Build a commit on top of `owner`'s current on-chain head and return it
	 * together with the UNSIGNED settlement tx — the self-custodial publish path.
	 *
	 * `commit` + `push` assume the caller holds the publishing key. A relay server
	 * doesn't: it builds and pins the commit with a keyless service wallet, then
	 * hands the tx to the user's browser wallet to sign. The head only moves when
	 * the publisher themselves signs, so the server is never a trusted party.
	 *
	 * Nothing is on-chain when this returns. The commit and its CAR are durable in
	 * storage, so if the user never signs, the result is an orphaned commit — junk
	 * in IPFS, not a corrupted timeline.
	 */
	async prepareCommit(opts: {
		/** The publisher whose head advances — NOT this client's service wallet. */
		owner: Hex;
		namespace: string;
		vertices?: { id: string; tag: string; payload: unknown }[];
		edges?: { rel: string; from: string; to: string }[];
		message: string;
		/** Snapshot semantics: the staged graph replaces the namespace's contents. */
		replace?: boolean;
	}): Promise<{
		commitCid: string;
		oldRoot: Hex;
		newRoot: Hex;
		staged: { vertices: number; edges: number };
		tx: PreparedTx;
		vertexCids: Record<string, string>;
	}> {
		assertValidNamespace(opts.namespace);
		const registry = this.getDataRegistry();

		const oldRoot = await registry.getNamespaceHead(opts.owner, opts.namespace);
		const { commitCid, vertexCids } = await this.createCommit({
			namespace: opts.namespace,
			base:
				oldRoot === ZERO_BYTES32
					? null
					: CID.parse(this.engine.commitCidFromRootHex(oldRoot)),
			vertices: opts.vertices ?? [],
			edges: opts.edges ?? [],
			message: opts.message,
			replace: opts.replace,
		});

		const newRoot = rootHexFromCid(commitCid);
		return {
			commitCid: commitCid.toString(),
			oldRoot,
			newRoot,
			staged: {
				vertices: opts.vertices?.length ?? 0,
				edges: opts.edges?.length ?? 0,
			},
			tx: await registry.prepareCommitStateRoot(
				opts.owner,
				opts.namespace,
				oldRoot,
				newRoot,
			),
			vertexCids,
		};
	}

	/**
	 * Settle a local commit as the on-chain head of `namespace` (fast-forward
	 * unless `force`). Each namespace has its own timeline, so pushes to
	 * different namespaces never contend for the same compare-and-swap.
	 */
	async push(
		namespace: string,
		commitCid: string,
		opts?: { force?: boolean },
	): Promise<{ txHash: string; onChainTip: string }> {
		const { txHash, onChainTip } = await this.engine.pushCommit(
			this.getAddress(),
			namespace,
			CID.parse(commitCid),
			opts,
		);
		return { txHash, onChainTip: onChainTip.toString() };
	}

	/** The owner's current on-chain tip for a namespace, or null if they have none. */
	async onChainTip(owner: Hex, namespace: string): Promise<string | null> {
		const cid = await this.engine.resolveHeadCommit(owner, namespace);
		return cid ? cid.toString() : null;
	}

	/**
	 * A publisher's namespace contents, cached against its on-chain tip.
	 *
	 * Reading a namespace walks the pail tree from the root — many sequential
	 * gateway fetches. The tip is one cheap contract read and only moves on
	 * publish, so it doubles as the cache key: no TTL to tune, no invalidation
	 * to remember after a settle, and never stale.
	 *
	 * LRU-bounded so an always-on process can't accumulate every namespace it
	 * ever touched. The durable copy is on-chain — an evicted entry re-walks.
	 * ponytail: fixed entry count, not byte-aware; switch to a size budget if a
	 * few huge namespaces blow memory before the count cap bites.
	 */
	async readNamespace(
		owner: Hex,
		namespace: string,
	): Promise<{ tip: string | null; contents: NamespaceContents }> {
		const key = `${owner.toLowerCase()}/${namespace}`;
		const tip = await this.onChainTip(owner, namespace);

		const hit = this.nsCache.get(key);
		if (hit?.tip === tip) {
			this.nsCache.delete(key); // promote to MRU
			this.nsCache.set(key, hit);
			return hit;
		}

		const entry = {
			tip,
			contents: await this.engine.listNamespace(namespace, owner),
		};
		this.nsCache.delete(key);
		this.nsCache.set(key, entry);
		if (this.nsCache.size > NS_CACHE_MAX) {
			const oldest = this.nsCache.keys().next().value;
			if (oldest !== undefined) this.nsCache.delete(oldest);
		}
		return entry;
	}

	/**
	 * Every (publisher, namespace) pair that has ever committed under this app,
	 * at its latest root — the app's directory, from ONE `getLogs`.
	 *
	 * This is what cross-publisher discovery looks like now: the registry already
	 * indexes `app_id`, so the commit log IS the index. No per-publisher fan-out,
	 * no separate registration sweep, no central list — and unlike a publisher
	 * roster it only surfaces publishers with actual content.
	 *
	 * Namespaces come back as `subspaceId` (the hash), not the name, because the
	 * event never carries the name — recovering it costs one content fetch per
	 * entry. Pass `namespace` when you know the name you're after (the usual
	 * case: an app with one well-known namespace) and the filter is applied
	 * on-chain instead.
	 */
	async appNamespaces(
		opts: { namespace?: string; owner?: Hex; fromBlock?: bigint } = {},
	): Promise<
		{ owner: Hex; subspaceId: Hex; root: Hex; blockNumber: bigint }[]
	> {
		const logs = await this.getDataRegistry().getStateCommittedLogs(
			{ publisher: opts.owner, namespace: opts.namespace },
			opts.fromBlock ?? 0n,
		);
		// Logs arrive oldest-first, so last write per timeline wins.
		const latest = new Map<
			Hex,
			{ owner: Hex; subspaceId: Hex; root: Hex; blockNumber: bigint }
		>();
		for (const log of logs) {
			latest.set(log.namespaceKey, {
				owner: log.publisher,
				subspaceId: log.subspaceId,
				root: log.newRoot,
				blockNumber: log.blockNumber,
			});
		}
		return [...latest.values()];
	}

	/**
	 * The app's commit stream as ONE shared, ref-counted subscription (see
	 * `AppFeed`). Prefer this over `subscribeApp` anywhere more than one consumer
	 * wants the same feed — a server fanning out to connections, say.
	 */
	appFeed(opts: { pollingInterval?: number } = {}): AppFeed {
		this._feed ??= new AppFeed((signal) =>
			this.subscribeApp({ ...opts, signal }),
		);
		return this._feed;
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

	// ── Subscription: a light client over the app's commit stream ──────────────
	//
	// Each `app:publisher:namespace` triple is its own on-chain timeline, and the
	// registry indexes all three parts of it, so a subscription is just a topic
	// filter: one namespace (`{ owner, namespace }`), one publisher across the
	// app (`{ owner }`), or the whole app (`{}` — see `subscribeApp`). For each
	// commit we diff the namespace's link sets against the previous root and emit
	// only when that slice actually changed. Reads logs straight from the RPC node
	// and resolves diffs from content-addressed storage (one CAR download per
	// push): no subgraph, no indexer.

	/**
	 * Stream changes to one publisher's namespace. Optionally replays from
	 * `fromBlock` first (resume cursor), then watches live until the `signal`
	 * aborts. Each yielded change carries `blockNumber` — persist it to resume
	 * exactly where you left off.
	 */
	subscribe(opts: SubscribeOptions): AsyncGenerator<NamespaceChange> {
		return this.streamCommits(
			{ publisher: opts.owner ?? this.getAddress(), namespace: opts.namespace },
			opts,
		);
	}

	/**
	 * Stream changes across the *whole app* — every publisher, every namespace.
	 * The app-level feed: one topic filter on `app_id`, no per-publisher fan-out
	 * and no global root to keep in sync. Narrow it with `namespace` (every
	 * publisher's `docs`) or `owner` (one publisher's whole app footprint).
	 */
	subscribeApp(
		opts: Omit<SubscribeOptions, "namespace"> & { namespace?: string } = {},
	): AsyncGenerator<NamespaceChange> {
		return this.streamCommits(
			{ publisher: opts.owner, namespace: opts.namespace },
			opts,
		);
	}

	/** Shared catch-up-then-live loop behind `subscribe` and `subscribeApp`. */
	private async *streamCommits(
		filter: CommitFilter,
		opts: Omit<SubscribeOptions, "namespace" | "owner">,
	): AsyncGenerator<NamespaceChange> {
		const registry = this.getDataRegistry();

		// Dedupe across the catch-up (getLogs) and live (watch) paths, which can
		// overlap around the current tip.
		const seen = new Set<string>();

		// Live events buffer here from the moment we subscribe, so nothing emitted
		// during catch-up is lost.
		const buffer: StateCommittedLog[] = [];
		let wake: (() => void) | null = null;

		// Grouping out-of-band state changes into an object so TypeScript's
		// control flow analyzer tracks updates across asynchronous tick boundaries.
		const subState = {
			failure: null as Error | null,
			stopped: false,
		};

		const signal = () => {
			const w = wake;
			wake = null;
			w?.();
		};

		const unwatch = registry.watchStateCommitted(
			filter,
			(log) => {
				buffer.push(log);
				signal();
			},
			(err) => {
				subState.failure = err;
				signal();
			},
			opts.pollingInterval,
		);

		const onAbort = () => {
			subState.stopped = true;
			signal();
		};
		opts.signal?.addEventListener("abort", onAbort);

		try {
			if (opts.fromBlock !== undefined) {
				for (const log of await registry.getStateCommittedLogs(
					filter,
					opts.fromBlock,
				)) {
					if (seen.has(log.logId)) continue;
					seen.add(log.logId);
					const change = await this.toNamespaceChange(log);
					if (change) yield change;
				}
			}

			while (!subState.stopped) {
				if (subState.failure) {
					throw subState.failure;
				}

				if (buffer.length === 0) {
					await new Promise<void>((res) => {
						wake = res;
					});
					continue;
				}

				const log = buffer.shift();
				if (!log) continue; // Safe fallback guard replacing forbidden '!' assertion

				if (seen.has(log.logId)) continue;
				seen.add(log.logId);
				const change = await this.toNamespaceChange(log);
				if (change) yield change;
			}
		} finally {
			unwatch();
			opts.signal?.removeEventListener("abort", onAbort);
		}
	}

	/**
	 * Resolve a raw `StateCommitted` log into a namespace change, or null if the
	 * namespace slice was untouched.
	 *
	 * The event carries `keccak256(namespace)`, never the name, so the name comes
	 * from the commit's own root map — and must hash back to the subspace the
	 * commit was published into, or the publisher settled a commit for one
	 * namespace against another's timeline.
	 */
	private async toNamespaceChange(
		log: StateCommittedLog,
	): Promise<NamespaceChange | null> {
		const namespace = await this.engine.namespaceOf(log.newRoot);
		if (subspaceId(namespace) !== log.subspaceId) {
			throw new Error(
				`commit ${log.newRoot} declares namespace "${namespace}", which does not match the subspace it was committed to (${log.subspaceId})`,
			);
		}

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
			owner: log.publisher,
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
		return this.ctx.dataRegistry;
	}

	/** The app (global namespace) this client publishes and reads under. */
	getAppId(): Hex {
		return this.ctx.dataRegistry.getAppId();
	}

	/**
	 * Point this client at a different app — by name (`"my-app"`) or by app id —
	 * without rebuilding it. The app id prefixes every namespace key, so every
	 * read, publish and subscription after this call lands in the new app.
	 *
	 * Namespace reads are dropped from the cache (its keys are app-agnostic) and
	 * the shared `appFeed` is released: a feed watches one app's commit stream, so
	 * the next `appFeed()` opens a fresh subscription. Generators already running
	 * from `subscribe`/`subscribeApp` keep their original filter until aborted.
	 */
	setAppId(nameOrId: string): void {
		this.ctx.dataRegistry.setAppId(toAppId(nameOrId));
		this.nsCache.clear();
		this._feed = null;
	}

	getStorage(): MetadataStorage {
		if (!this.ctx.metadataStorage) {
			throw new Error(
				"storage is not configured. Pass { pinata: { ... } } or { signedUrl: { ... } } to Fangorn.create()",
			);
		}
		return this.ctx.metadataStorage;
	}

	/**
	 * Swap the storage backend at runtime — e.g. move from access-worker signed
	 * URLs to your own Pinata JWT (or back). Rebuilds the engine on next use so it
	 * picks up the new backend.
	 */
	setStorage(storage: StorageConfig): void {
		this.ctx.metadataStorage = resolveStorage(
			storage,
			this.ctx.walletClient,
			this.ctx.config,
		);
		this._engine = null;
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
