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

import { AppConfig, FangornConfig, nonBlank, toAppId } from "./config.js";
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
	assertValidRepoName,
	FangornEngine,
	RepoContents,
	RepoDiff,
	RecordInput,
	rootHexFromCid,
	SchemaRegistry,
} from "./engine/index.js";
import {
	AppRegistryClient,
	PreparedTx,
	MembershipRegistryClient,
} from "./contracts/index.js";
import {
	ChainRegistry,
	LogFilter,
	Registry,
	RepoRef,
	UpdateEntry,
	ZERO_HEAD,
	repoExcluded,
} from "./registry.js";
import { AppFeed } from "./feed.js";

const ZERO_BYTES32 = ZERO_HEAD;

// max number repos held in the cache at once
const NS_CACHE_MAX = 256;

// represents a repo diff (i.e. what changed between two commits)
export interface RepoChange extends RepoDiff {
	repo: string;
	owner: Hex;
	// The commit CID (NEW on-chain tip)
	commitCid: string;
	// the root of the old state of the repo
	oldRoot: Hex;
	// the root of the new (updated) state of the repo
	newRoot: Hex;
	// when the new root was minted onchain
	blockNumber: bigint;
}

export interface SubscribeOptions {
	repo: string;
	/**
	 * Under an app, the stream follows what the app presents (its members' updates,
	 * less exclusions); with no app, every update the publisher commits.
	 */
	/** Publisher whose repo to watch (defaults to this wallet's address). */
	owner?: Hex;
	/**
	 * Replay `StateCommitted` events from this block before going live (the resume
	 * cursor). Omit to start live from the current chain tip — seed initial state
	 * separately via `inspectRepo`.
	 */
	fromBlock?: bigint;
	/** Poll interval (ms) for the live watch over an HTTP transport. */
	pollingInterval?: number;
	/** Abort to stop the subscription and release the watch. */
	signal?: AbortSignal;
}

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
	// Read per upload, not captured: `setAppId` must reach uploads already
	// configured, or they would keep billing the previous app.
	getAppId: () => Hex | undefined,
): MetadataStorage | undefined {
	if (!storage) return undefined;
	if ("backend" in storage) return storage.backend;
	if ("pinata" in storage)
		return new PinataBackend(storage.pinata.jwt, storage.pinata.gateway);
	if ("signedUrl" in storage) {
		// Apps provide storage: the hosted worker bills the client's app. Without
		// one, a publisher brings its own Pinata (or any backend) and pins itself.
		return new SignedUrlBackend(
			storage.signedUrl.workerUrl,
			walletSigner(walletClient),
			storage.signedUrl.gateway ?? config.ipfsGateway,
			getAppId,
		);
	}
	throw new Error(
		`Invalid storage config: must be { pinata: … }, { signedUrl: … } or { backend: … }, got ${JSON.stringify(storage)}`,
	);
}

/** The A2A extension a Fangorn app's agent card carries: it names the app the card speaks for. */
export const FANGORN_APP_EXTENSION = "https://fangorn.network/a2a/app/v1";

/**
 * The part of an A2A agent card `discoverApp` reads. A card's other fields
 * (skills, endpoints and so on) pass through untouched.
 */
export interface AgentCard {
	name?: string;
	description?: string;
	url?: string;
	capabilities?: {
		extensions?: { uri: string; params?: Record<string, unknown> }[];
	};
	[key: string]: unknown;
}

export class Fangorn {

	private readonly ctx: FangornContext;

	private _engine: FangornEngine | null = null;

	private readonly _schemas = new SchemaRegistry();

	private _feed: AppFeed | null = null;

	private _apps: AppRegistryClient | null = null;

	private _membership: MembershipRegistryClient | null = null;

	/** 
	 * The repo cache
	 * Insertion order = LRU order
	 */
	private readonly nsCache = new Map<
		string,
		{ tip: string | null; contents: RepoContents }
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
			this._schemas,
			this.ctx.registry,
		);
		return this._engine;
	}

	/** Per-repo record schemas. Unregistered types are accepted as-is. */
	get schemas(): SchemaRegistry {
		return this._schemas;
	}

	/**
	 * Static creation of a new Fangorn client
	 * 
	 * @param options 
	 * @returns the client
	 */
	static create(options: FangornCreateOptions): Fangorn {
		if (!options.privateKey && !options.walletClient) {
			throw new Error("Either privateKey or walletClient must be provided");
		}

		const config = options.config ?? FangornConfig;

		const walletClient =
			options.walletClient ??
			createWalletClient({
				account: privateKeyToAccount(options.privateKey ?? "0x0"),
				chain: config.chain,
				transport: http(config.rpcUrl),
			});

		const publicClient = createPublicClient({
			chain: config.chain,
			transport: http(config.rpcUrl),
		}) as PublicClient;

		// Blank is "no app chosen", not an app called "". An empty FANGORN_APP_ID
		// or `--app ""` must not silently scope reads or billing to keccak("").
		const chosenApp = nonBlank(options.appId);

		const ctx: FangornContext = {
			config,
			walletClient,
			publicClient,
			appId: chosenApp ? toAppId(chosenApp) : undefined,
			metadataStorage: undefined,
			registry: options.registry ?? new ChainRegistry(config, publicClient, walletClient),
		};
		ctx.metadataStorage = resolveStorage(options.storage, walletClient, config, () => ctx.appId);
		return new Fangorn(ctx);
	}

	/**
	 * Empties a repo: one commit of the empty state on top of the head. History
	 * stays (a head never goes back to zero), and so do the old records: the new
	 * head still names them as history.
	 */
	async reset(repo: string) {
		const publisher = this.getAddress();
		const head = await this.engine.resolveHeadCommit(publisher, repo);
		const { commitCid } = await this.createCommit({
			repo,
			base: head,
			records: [],
			message: `Reset ${repo}`,
			replace: true,
		});
		return this.engine.pushCommit(publisher, repo, commitCid);
	}

	/** Stage records into one commit on top of `base`. */
	private createCommit(opts: {
		repo: string;
		base: CID | null;
		records: { id?: string; type: string; payload: unknown }[];
		deletes?: string[];
		message: string;
		replace?: boolean;
	}) {
		return this.engine.createCommit({
			...opts,
			// Payloads are objects (field names → values); wrap anything else.
			records: opts.records.map((r) => ({
				id: r.id,
				type: r.type,
				payload:
					r.payload && typeof r.payload === "object" && !Array.isArray(r.payload)
						? (r.payload as Record<string, unknown>)
						: { value: r.payload },
			})),
		});
	}

	/**
	 * Allocates a repo in the publisher's root map. 
	 * A no-op (no on-chain tx) if the repo is already initialized.
	 */
	async initRepo(repoName: string) {
		assertValidRepoName(repoName);
		const publisher = this.getAddress();

		if (await this.engine.repoExists(publisher, repoName)) {
			return {
				cid: undefined,
				commitCid: undefined,
				txHash: undefined,
				alreadyInitialized: true as const,
			};
		}

		// Continue the publisher's on-chain history with a commit that adds the
		// repo (as an empty tree) to the root map.
		const head = await this.engine.resolveHeadCommit(publisher, repoName);
		const { commitCid } = await this.createCommit({
			repo: repoName,
			base: head,
			records: [],
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
	 * Put one record and settle it on-chain in a single shot. `id` defaults to
	 * a random one, so repeated calls add records; pass an id to update one.
	 */
	async upload(repoName: string, payload: unknown, type: string, id?: string) {
		const publisher = this.getAddress();
		const head = await this.engine.resolveHeadCommit(publisher, repoName);
		// can't upload to a zero-state chain.
		if (!head) {
			throw new Error(
				`Repository '${repoName}' does not exist. Call initRepo() prior to uploading.`,
			);
		}

		const { commitCid, recordCids } = await this.createCommit({
			repo: repoName,
			base: head,
			records: [{ id, type, payload }],
			message: `Upload to repo ${repoName} as type ${type}`,
		});
		const { txHash } = await this.engine.pushCommit(
			publisher,
			repoName,
			commitCid,
		);

		const [[recordId, payloadCid]] = Object.entries(recordCids);
		return {
			id: recordId,
			payloadCid,
			commitCid: commitCid.toString(),
			txHash,
		};
	}

	/**
	 * Puts many records (and deletes some, by id) under one repo in a
	 * single commit, instead of one tx per record. Built in memory and persisted
	 * as ONE CAR upload plus one commit block, then settled in a single
	 * fast-forward tx. Relations are records too: give them `src`/`dst` `Ref`s.
	 */
	async uploadBatch(
		repoName: string,
		records: RecordInput[],
		deletes: string[] = [],
	) {
		assertValidRepoName(repoName);
		if (records.length === 0 && deletes.length === 0) {
			throw new Error("uploadBatch requires at least one record or delete");
		}

		const publisher = this.getAddress();
		const head = await this.engine.resolveHeadCommit(publisher, repoName);
		if (!head) {
			throw new Error(
				`Repository '${repoName}' does not exist. Call initRepo() prior to uploading.`,
			);
		}

		const { commitCid, recordCids } = await this.createCommit({
			repo: repoName,
			base: head,
			records,
			deletes,
			message: `Batch upload to repo ${repoName}`,
		});

		const { txHash } = await this.engine.pushCommit(
			publisher,
			repoName,
			commitCid,
		);

		return {
			commitCid: commitCid.toString(),
			txHash,
			recordCids,
		};
	}

	// ── Git-native flow: local commit → push, plus history/diff/clone ──────────
	//
	// These decouple building state from the on-chain settle. `commit` snapshots
	// data into a new commit object (durable in storage, but the on-chain head is
	// untouched — like writing to `.git/objects`); `push` fast-forwards the
	// on-chain head to a local commit (the permissioned ref update).

	/**
	 * Build a new commit (no on-chain tx) that puts/deletes records in
	 * `repo` on top of `parent` (a commit CID string, or undefined for a
	 * root commit). The commit and its CAR are uploaded to storage, so a later
	 * `push` — even in a separate process — can settle it.
	 */
	async commit(opts: {
		repo: string;
		records?: RecordInput[];
		deletes?: string[];
		parent?: string;
		message: string;
		/** Snapshot semantics: the staged records replace the repo's previous contents. */
		replace?: boolean;
	}): Promise<{
		commitCid: string;
		parent: string | null;
		root: string;
		recordCids: Record<string, string>;
	}> {
		assertValidRepoName(opts.repo);
		const parentCid = opts.parent ? CID.parse(opts.parent) : null;

		const { commitCid, root, recordCids } = await this.createCommit({
			repo: opts.repo,
			base: parentCid,
			records: opts.records ?? [],
			deletes: opts.deletes,
			message: opts.message,
			replace: opts.replace,
		});

		return {
			commitCid: commitCid.toString(),
			parent: parentCid?.toString() ?? null,
			root: root.toString(),
			recordCids,
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
		repo: string;
		records?: RecordInput[];
		deletes?: string[];
		message: string;
		/** Snapshot semantics: the staged records replace the repo's contents. */
		replace?: boolean;
	}): Promise<{
		commitCid: string;
		oldRoot: Hex;
		newRoot: Hex;
		staged: { records: number; deletes: number };
		tx: PreparedTx;
		recordCids: Record<string, string>;
	}> {
		assertValidRepoName(opts.repo);
		const registry = this.ctx.registry;

		const oldRoot = await registry.head({ publisher: opts.owner, repo: opts.repo });
		const { commitCid, recordCids } = await this.createCommit({
			repo: opts.repo,
			base:
				oldRoot === ZERO_BYTES32
					? null
					: CID.parse(this.engine.commitCidFromRootHex(oldRoot)),
			records: opts.records ?? [],
			deletes: opts.deletes,
			message: opts.message,
			replace: opts.replace,
		});

		const newRoot = rootHexFromCid(commitCid);
		return {
			commitCid: commitCid.toString(),
			oldRoot,
			newRoot,
			staged: {
				records: opts.records?.length ?? 0,
				deletes: opts.deletes?.length ?? 0,
			},
			tx: await registry.prepareUpdate(
				opts.owner,
				opts.repo,
				oldRoot,
				newRoot,
			),
			recordCids,
		};
	}

	/**
	 * Settle a local commit as the on-chain head of `repo`. Its parent must be
	 * the current head (see `FangornEngine.pushCommit`). Each repo has its own
	 * timeline, so pushes to different repos never contend.
	 */
	async push(
		repo: string,
		commitCid: string,
	): Promise<{ txHash: string; onChainTip: string }> {
		const { txHash, onChainTip } = await this.engine.pushCommit(
			this.getAddress(),
			repo,
			CID.parse(commitCid),
		);
		return { txHash, onChainTip: onChainTip.toString() };
	}

	/** The owner's current on-chain tip for a repo, or null if they have none. */
	async onChainTip(owner: Hex, repo: string): Promise<string | null> {
		const cid = await this.engine.resolveHeadCommit(owner, repo);
		return cid ? cid.toString() : null;
	}

	/**
	 * A publisher's repo as this client presents it, cached against its tip:
	 * the publisher's latest head, or, under an app, nothing unless the app
	 * presents the publisher (provides its storage) and excludes neither it nor
	 * the repo.
	 *
	 * Reading a repo walks its whole record tree from the root. The tip is one
	 * cheap contract read and only moves on publish, so it doubles as the cache
	 * key: no TTL to tune, no invalidation to remember after a settle, and never
	 * stale.
	 *
	 * LRU-bounded so an always-on process can't accumulate every repo it
	 * ever touched. The durable copy is on-chain — an evicted entry re-walks.
	 * ponytail: fixed entry count, not byte-aware; switch to a size budget if a
	 * few huge repos blow memory before the count cap bites.
	 */
	async readRepo(
		owner: Hex,
		repo: string,
	): Promise<{ tip: string | null; contents: RepoContents }> {
		const key = `${owner.toLowerCase()}/${repo}`;
		const tip = await this.presentedTip({ publisher: owner, repo });

		const hit = this.nsCache.get(key);
		if (hit?.tip === tip) {
			this.nsCache.delete(key); // TODO: promote to MRU?
			this.nsCache.set(key, hit);
			return hit;
		}

		const entry = {
			tip,
			contents: await this.engine.listAt(tip ? CID.parse(tip) : null),
		};
		this.nsCache.delete(key);
		this.nsCache.set(key, entry);
		if (this.nsCache.size > NS_CACHE_MAX) {
			const oldest = this.nsCache.keys().next().value;
			if (oldest !== undefined) this.nsCache.delete(oldest);
		}
		return entry;
	}

	/** The commit this client presents of a repo, or null for none (see `readRepo`). */
	private async presentedTip(ref: RepoRef): Promise<string | null> {
		const app = this.ctx.appId;
		const registry = this.ctx.registry;
		if (app && !(await this.presentsRepo(app, ref))) return null;
		const head = await registry.head(ref);
		return head === ZERO_BYTES32 ? null : this.engine.commitCidFromRootHex(head);
	}

	/** Does `app` present `ref`: it presents the publisher, and excludes neither it nor the repo? */
	private async presentsRepo(app: Hex, ref: RepoRef): Promise<boolean> {
		const registry = this.ctx.registry;
		const [presents, excluded] = await Promise.all([
			registry.presents(app, ref.publisher),
			repoExcluded(registry, app, ref),
		]);
		return presents && !excluded;
	}

	/**
	 * Every (publisher, repo) this client's app presents, at its latest head, less
	 * what it excludes — the app's directory, from ONE `getLogs` over the update
	 * log, kept to the publishers the app presents.
	 *
	 * ponytail: reads every publisher's updates and drops non-members, so it costs
	 * what the network writes, not what the app holds. Filter on-chain by the
	 * app's members (a `publisher` topic list) once that is too slow.
	 * Narrow it with `repo` (every publisher's `docs`) or `owner`, filtered on-chain.
	 */
	async appRepos(
		opts: { repo?: string; owner?: Hex; fromBlock?: bigint } = {},
	): Promise<{ owner: Hex; repo: string; root: Hex; blockNumber: bigint }[]> {
		const app = this.requireApp("appRepos");
		const registry = this.ctx.registry;
		const entries = await registry.log(
			{ publisher: opts.owner, repo: opts.repo },
			opts.fromBlock ?? this.ctx.config.appRegistryFromBlock,
		);
		// Entries arrive oldest-first, so the last update per repo wins.
		const latest = new Map<string, { owner: Hex; repo: string; root: Hex; blockNumber: bigint }>();
		for (const e of entries) {
			latest.set(`${e.publisher.toLowerCase()}/${e.repo}`, {
				owner: e.publisher,
				repo: e.repo,
				root: e.head,
				blockNumber: e.t,
			});
		}
		const all = [...latest.values()];
		const kept = await Promise.all(all.map((d) => this.presentsRepo(app, { publisher: d.owner, repo: d.repo })));
		return all.filter((_, i) => kept[i]);
	}

	/**
	 * Resolve an app from its agent card URL alone, and prove the card speaks for it.
	 *
	 * The card names its app in the `FANGORN_APP_EXTENSION` A2A extension, but
	 * anyone can serve a card that names any app. So the card is trusted only if
	 * the app's on-chain `agent_uri`, which only the app owner can set, points
	 * back at this exact URL. The comparison is exact string equality, so a
	 * trailing slash or a different host counts as a different card.
	 *
	 * Doesn't touch this client's app. Pass `appId` to `setAppId` to read under it.
	 */
	async discoverApp(cardUrl: string): Promise<{
		card: AgentCard;
		appId: Hex;
		fromBlock: bigint;
		repos: string[];
	}> {
		const res = await fetch(cardUrl, { signal: AbortSignal.timeout(10_000) });
		if (!res.ok) throw new Error(`agent card ${cardUrl}: HTTP ${String(res.status)}`);
		const card = (await res.json()) as AgentCard;

		const ext = card.capabilities?.extensions?.find((e) => e.uri === FANGORN_APP_EXTENSION);
		if (!ext) throw new Error(`agent card ${cardUrl} has no ${FANGORN_APP_EXTENSION} extension`);
		const p = ext.params ?? {};
		if (typeof p.appId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(p.appId)) {
			throw new Error(`agent card ${cardUrl}: appId is not a 32-byte hex string`);
		}
		if (typeof p.fromBlock !== "string" || !/^\d+$/.test(p.fromBlock)) {
			throw new Error(`agent card ${cardUrl}: fromBlock is not a decimal block number`);
		}
		// `namespaces` is the field's name on cards published before the rename.
		const repos = p.repos ?? p.namespaces ?? [];
		if (!Array.isArray(repos) || !repos.every((n) => typeof n === "string")) {
			throw new Error(`agent card ${cardUrl}: repos is not a list of strings`);
		}
		// Checked before the binding: a card from another deployment would
		// otherwise fail as "not bound", which sends the reader looking for a forgery.
		const apps = this.getAppRegistry();
		if (
			p.chainId !== this.ctx.config.caip2 ||
			typeof p.appRegistry !== "string" ||
			p.appRegistry.toLowerCase() !== apps.getAddress().toLowerCase()
		) {
			throw new Error(
				`agent card ${cardUrl} is for chain ${String(p.chainId)} / AppRegistry ${String(p.appRegistry)}, not this client's`,
			);
		}

		const appId = p.appId as Hex;
		const bound = await apps.appAgentUri(appId);
		if (bound !== cardUrl) {
			throw new Error(
				`agent card ${cardUrl} is not bound to app ${appId}: its on-chain agent_uri is ${bound ? `"${bound}"` : "unset"}`,
			);
		}
		return { card, appId, fromBlock: BigInt(p.fromBlock), repos };
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
		parent: string | null;
		epoch: number;
		message: string;
		root: string;
	}> {
		for await (const { cid, commit } of this.engine.walkParents(
			CID.parse(head),
			max,
		)) {
			yield {
				cid: cid.toString(),
				parent: commit.parent?.toString() ?? null,
				epoch: commit.epoch,
				message: commit.message,
				root: commit.root.toString(),
			};
		}
	}

	/** Show a commit and what it changed vs. its parent. */
	async show(commitCid: string) {
		return this.engine.diffCommit(CID.parse(commitCid));
	}

	/**
	 * Lists every record currently committed under a repo, resolved
	 * from the publisher's on-chain root — useful for verifying what actually
	 * made it into the repository, as opposed to what a given call staged.
	 */
	async inspectRepo(repoName: string): Promise<RepoContents> {
		return this.engine.listRepo(this.getAddress(), repoName);
	}

	// ── Subscription: a light client over the app's commit stream ──────────────
	//
	// Each `publisher:repo` pair is its own on-chain timeline, and the registry
	// indexes both parts of it, so a subscription is a topic filter: one repo
	// (`{ owner, repo }`), one publisher (`{ owner }`), or every repo (`{}` — see
	// `subscribeApp`), kept to what this client's app presents. For each
	// commit we diff the repo's record map against the previous root and emit
	// only when that slice actually changed. Reads logs straight from the RPC node
	// and resolves diffs from content-addressed storage (one CAR download per
	// push): no subgraph, no indexer.

	/**
	 * Stream changes to one publisher's repo. Optionally replays from
	 * `fromBlock` first (resume cursor), then watches live until the `signal`
	 * aborts. Each yielded change carries `blockNumber` — persist it to resume
	 * exactly where you left off.
	 */
	subscribe(opts: SubscribeOptions): AsyncGenerator<RepoChange> {
		return this.streamCommits(
			{ publisher: opts.owner ?? this.getAddress(), repo: opts.repo },
			opts,
		);
	}

	/**
	 * Stream changes across the *whole app* — every repo of every publisher it
	 * presents, less its exclusions. Narrow it with `repo` (every publisher's `docs`) or
	 * `owner` (one publisher's whole app footprint). With no app, every update by
	 * anyone: a firehose.
	 */
	subscribeApp(
		opts: Omit<SubscribeOptions, "repo"> & { repo?: string } = {},
	): AsyncGenerator<RepoChange> {
		return this.streamCommits(
			{ publisher: opts.owner, repo: opts.repo },
			opts,
		);
	}

	/** Shared catch-up-then-live loop behind `subscribe` and `subscribeApp`. */
	private async *streamCommits(
		filter: LogFilter,
		opts: Omit<SubscribeOptions, "repo" | "owner">,
	): AsyncGenerator<RepoChange> {
		const registry = this.ctx.registry;

		// Dedupe across the catch-up (getLogs) and live (watch) paths, which can
		// overlap around the current tip.
		const seen = new Set<string>();
		// The last head yielded per repo, to diff across a dropped entry.
		const lastHead = new Map<string, Hex>();

		// Live events buffer here from the moment we subscribe, so nothing emitted
		// during catch-up is lost.
		const buffer: UpdateEntry[] = [];
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

		const unwatch = registry.watch(
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
				for (const log of await registry.log(filter, opts.fromBlock)) {
					if (seen.has(log.id)) continue;
					seen.add(log.id);
					const change = await this.toRepoChange(log, lastHead);
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

				if (seen.has(log.id)) continue;
				seen.add(log.id);
				const change = await this.toRepoChange(log, lastHead);
				if (change) yield change;
			}
		} finally {
			unwatch();
			opts.signal?.removeEventListener("abort", onAbort);
		}
	}

	/**
	 * Resolve a log entry into a repo change, or null if nothing presented
	 * changed: the repo slice was untouched, or the app excludes it.
	 *
	 * The commit itself names its repo, which must be the one the entry was
	 * logged under, or the publisher settled a commit for one repo against
	 * another's timeline.
	 *
	 * The diff runs from the last head this stream saw for the repo, not from
	 * the entry's parent. If an entry was dropped (an RPC that left out a log),
	 * the two differ, and diffing from the entry's parent would skip what the
	 * dropped entry changed.
	 */
	private async toRepoChange(
		log: UpdateEntry,
		lastHead: Map<string, Hex>,
	): Promise<RepoChange | null> {
		const declared = await this.engine.repoOf(log.head);
		if (declared !== log.repo) {
			throw new Error(
				`commit ${log.head} declares repo "${declared}", which does not match the repo it was committed to ("${log.repo}")`,
			);
		}
		const ref = { publisher: log.publisher, repo: log.repo };
		if (this.ctx.appId && !(await this.presentsRepo(this.ctx.appId, ref))) return null;

		const key = `${log.publisher.toLowerCase()}/${log.repo}`;
		const oldRoot = lastHead.get(key) ?? log.parent;
		lastHead.set(key, log.head);
		const diff = await this.engine.repoDiff(
			oldRoot === ZERO_BYTES32 ? null : oldRoot,
			log.head,
		);
		if (!diff.puts.length && !diff.deletes.length) return null;

		return {
			repo: log.repo,
			owner: log.publisher,
			commitCid: this.engine.commitCidFromRootHex(log.head),
			oldRoot,
			newRoot: log.head,
			blockNumber: log.t,
			...diff,
		};
	}

	getConfig(): AppConfig {
		return this.ctx.config;
	}

	/** Heads, membership, exclusions and logs: the registry of WHITEPAPER_1 §3.2. */
	getRegistry(): Registry {
		return this.ctx.registry;
	}

	/**
	 * App management: claiming an app (its storage subscription), terms,
	 * invitations and membership, the agent card, and the protocol admin's powers.
	 * The owner accepts a publisher (`acceptPublisher()`); from then its uploads
	 * bill the app's subscription, and the app presents its repos.
	 */
	getAppRegistry(): AppRegistryClient {
		this._apps ??= new AppRegistryClient(
			this.ctx.config.appRegistryContractAddress,
			this.ctx.appId,
			this.ctx.publicClient,
			this.ctx.walletClient,
			this.ctx.config.logWindow,
		);
		return this._apps;
	}

	getMembershipRegistry(): MembershipRegistryClient {
		this._membership ??= new MembershipRegistryClient(
			this.ctx.config.membershipRegistryContractAddress,
			this.ctx.publicClient,
			this.ctx.walletClient,
		);
		return this._membership;
	}

	/** The app this client reads and publishes under, or undefined for none. */
	getAppId(): Hex | undefined {
		return this.ctx.appId;
	}

	private requireApp(what: string): Hex {
		if (!this.ctx.appId) throw new Error(`${what} needs an app: pass \`appId\` to Fangorn.create() or call setAppId()`);
		return this.ctx.appId;
	}

	/**
	 * Point this client at a different app — by name (`"my-app"`) or by app id —
	 * or at none, without rebuilding it. Every read, publish and subscription
	 * after this call is in the new context.
	 *
	 * Repo reads are dropped from the cache (its keys are app-agnostic) and
	 * the shared `appFeed` is released: a feed watches one app's commit stream, so
	 * the next `appFeed()` opens a fresh subscription. Generators already running
	 * from `subscribe`/`subscribeApp` keep their original filter until aborted.
	 */
	setAppId(nameOrId: string | undefined): void {
		const chosen = nonBlank(nameOrId);
		this.ctx.appId = chosen ? toAppId(chosen) : undefined;
		this._apps?.setAppId(this.ctx.appId);
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
			() => this.ctx.appId,
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
