import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as Digest from "multiformats/hashes/digest";
import { type Address, type Hash, type Hex } from "viem";
import { DataRegistryClient } from "../contracts";
import { MetadataStorage } from "../providers/storage/types.js";
import {
	Block,
	CommitBlock,
	EdgeBlock,
	NamespaceTree,
	RootMap,
	VertexBlock,
	buildPages,
	decodeBlock,
	encodeBlock,
	readPages,
} from "./graph.js";
import { packCar, readCar } from "./car.js";

export type SchemaID = string;
export type RelationLabel = string;
export type NamespaceID = string;

export interface Vertex {
	schemaId: SchemaID;
	payload: Record<string, unknown>;
}

export interface Edge {
	sourceCid: string;
	relation: RelationLabel;
	targetCid: string;
}

export interface VertexSchema {
	id: SchemaID;
	requiredFields: string[];
}

export interface EdgeSchema {
	sourceSchema: SchemaID;
	relation: RelationLabel;
	targetSchema: SchemaID;
}

/** A decoded commit — the git-like history object the on-chain digest points at. */
export interface CommitObject {
	/** Link to the publisher's root map (namespace → tree). */
	root: CID;
	parents: CID[];
	timestamp: number;
	message: string;
	/** Opaque storage URI of the CAR file holding the blocks this commit introduced. */
	car: string;
}

export interface NamespaceContents {
	vertices: {
		cid: string;
		schemaId: SchemaID;
		payload: Record<string, unknown>;
	}[];
	edges: Edge[];
}

/** Net change to one namespace between two on-chain roots (see `namespaceDiff`). */
export interface NamespaceDiff {
	/** Vertices new vs. the old root, decoded to their payloads. */
	addedVertices: NamespaceContents["vertices"];
	/** Edges new vs. the old root. */
	addedEdges: Edge[];
	/** CIDs of vertices present at the old root but gone at the new one. */
	removedVertexCids: string[];
	/** Edges present at the old root but gone at the new one. */
	removedEdges: Edge[];
}

export class MetagraphRegistry {
	private vertexSchemas = new Map<string, VertexSchema>();
	private edgeSchemas = new Set<string>();

	public registerVertex(namespace: NamespaceID, schema: VertexSchema): void {
		this.vertexSchemas.set(`${namespace}|${schema.id}`, schema);
	}

	public hasVertexSchema(namespace: NamespaceID, schemaId: SchemaID): boolean {
		return this.vertexSchemas.has(`${namespace}|${schemaId}`);
	}

	public registerEdge(namespace: NamespaceID, rule: EdgeSchema): void {
		this.edgeSchemas.add(
			`${namespace}|${rule.sourceSchema}|${rule.relation}|${rule.targetSchema}`,
		);
	}

	public hasEdgeSchema(
		namespace: NamespaceID,
		sourceSchema: SchemaID,
		relation: RelationLabel,
		targetSchema: SchemaID,
	): boolean {
		return this.edgeSchemas.has(
			`${namespace}|${sourceSchema}|${relation}|${targetSchema}`,
		);
	}

	public validateVertex(
		namespace: NamespaceID,
		schemaId: SchemaID,
		payload: Record<string, unknown>,
	): boolean {
		const schema = this.vertexSchemas.get(`${namespace}|${schemaId}`);
		if (!schema) return false;
		return schema.requiredFields.every((field) => field in payload);
	}

	public validateEdge(
		namespace: NamespaceID,
		sourceSchema: SchemaID,
		relation: RelationLabel,
		targetSchema: SchemaID,
	): boolean {
		return this.edgeSchemas.has(
			`${namespace}|${sourceSchema}|${relation}|${targetSchema}`,
		);
	}
}

const ZERO_BYTES32 =
	"0x0000000000000000000000000000000000000000000000000000000000000000";

/**
 * Upper bound on a namespace name's length. Namespaces are keys of the root
 * map block, so this is just a sanity bound keeping that block small and
 * rejecting garbage input early.
 */
/**
 * The 32-byte root a commit settles to on-chain.
 *
 * The contract stores the commit CID's bare multihash digest — NOT a hash of the
 * CID. Re-hashing here would produce a root that resolves to nothing, so this is
 * the one encoding every caller must share rather than re-derive.
 */
export function rootHexFromCid(commitCid: CID): Hex {
	return `0x${Buffer.from(commitCid.multihash.digest).toString("hex")}`;
}

export const MAX_NAMESPACE_LENGTH = 256;

/** Reject invalid namespace names up front with a clear error. */
export function assertValidNamespace(namespace: NamespaceID): void {
	if (typeof namespace !== "string" || namespace.length === 0) {
		throw new Error("namespace must be a non-empty string");
	}
	if (namespace.length > MAX_NAMESPACE_LENGTH) {
		throw new Error(
			`namespace exceeds the maximum length of ${MAX_NAMESPACE_LENGTH.toString()} characters ` +
			`(got ${namespace.length.toString()}).`,
		);
	}
}

/** One line of a commit's diff against its first parent. */
export interface CommitDiff {
	message: string;
	parents: string[];
	timestamp: number;
	root: string;
	/** namespaced entries (`<ns>/v/<cid>`, `<ns>/e/<cid>`) new vs. the parent. */
	added: string[];
	/** namespaced entries present in the parent but gone in this commit. */
	removed: string[];
}

/** Input to `createCommit`: a graph staged under one namespace. */
export interface CreateCommitOptions {
	namespace: NamespaceID;
	/** Parent commit this builds on (local HEAD or on-chain tip), or null for a root commit. */
	base: CID | null;
	/** Vertices keyed by a caller-local id, so edges can reference them. */
	vertices: {
		id: string;
		schemaId: SchemaID;
		payload: Record<string, unknown>;
	}[];
	/**
	 * Edges between vertices. Endpoints are local ids of vertices staged in
	 * this same call, or full CIDs of vertices committed earlier (CIDs are
	 * content-addressed and stable across commits).
	 */
	edges: { relation: RelationLabel; from: string; to: string }[];
	message: string;
	/**
	 * When true, the staged graph REPLACES the namespace's previous contents
	 * (a snapshot commit — anything omitted is removed). Default is additive:
	 * new state = parent state ∪ staged.
	 */
	replace?: boolean;
}

/** The links (namespace contents) behind one commit's view of a namespace. */
interface TreeLinks {
	vertexLinks: CID[];
	edgeLinks: CID[];
	/** Page + tree block CIDs, for delta computation. */
	structureCids: Set<string>;
}

export class FangornEngine {
	/**
	 * Local block cache. Written blocks land here immediately; remote blocks
	 * are pulled in whole-CAR-at-a-time by `loadCar`. Content addressing makes
	 * the cache trivially coherent.
	 */
	private cache = new Map<string, Uint8Array>();
	/** Commits whose CAR has already been loaded into the cache. */
	private loadedCars = new Set<string>();

	constructor(
		private storage: MetadataStorage,
		private metagraph: MetagraphRegistry,
		private registryClient: DataRegistryClient,
	) { }

	/**
	 * Reconstructs the CID a commit's raw digest hex refers to. The contract only
	 * stores the bare 32-byte sha256 digest (see commitStateRoot), so rebuilding
	 * the CID must wrap that digest directly via Digest.create — hashing it again
	 * with sha256.digest() would produce an unrelated CID pointing at nothing.
	 */
	private hexToRootCid(hex: string): CID {
		const cleanHex = hex.startsWith("0x") ? hex.slice(2) : hex;
		const rawDigestBytes = Uint8Array.from(Buffer.from(cleanHex, "hex"));
		const multihash = Digest.create(sha256.code, rawDigestBytes);
		// Commits are dag-cbor (0x71) blocks.
		return CID.createV1(0x71, multihash);
	}

	// ── Block resolution ─────────────────────────────────────────────────────
	//
	// Two kinds of remote reads, mirroring git's loose-object/packfile split:
	//   • commit blocks are stored individually (putBlock) and fetched directly
	//     by CID — the entry point from the on-chain digest;
	//   • every other block lives inside some commit's CAR (a packfile). To
	//     resolve one, walk the commit chain from a hint commit, loading each
	//     ancestor's CAR into the local cache until the block appears.

	/** Read and decode a commit object by CID (directly addressable — no CAR needed). */
	async getCommit(commitCid: CID): Promise<CommitObject> {
		const key = commitCid.toString();
		let bytes = this.cache.get(key);
		if (!bytes) {
			bytes = await this.storage.getRawBlock(key);
			this.cache.set(key, bytes);
		}
		const decoded = decodeBlock<{
			root?: unknown;
			parents?: unknown[];
			timestamp?: number;
			message?: string;
			car?: string;
			pailRoot?: unknown;
		}>(bytes);
		if (decoded.pailRoot !== undefined) {
			throw new Error(
				`commit ${key} predates the v2 data layer (pail-era). ` +
				"Reset the on-chain head (`fangorn reset`) and re-publish.",
			);
		}
		const rawRoot: unknown = decoded.root;
		const root =
			CID.asCID(rawRoot) ??
			(typeof rawRoot === "string" ? CID.parse(rawRoot) : null);
		if (!root) {
			// Otherwise this fails as CID.parse("undefined") — a parser complaint
			// that never names the block it came from.
			throw new Error(
				`commit ${key} has no usable root link (not a commit block?)`,
			);
		}
		return {
			root,
			parents: (decoded.parents ?? []).map((p) => CID.parse(String(p))),
			timestamp: decoded.timestamp ?? 0,
			message: decoded.message ?? "",
			car: decoded.car ?? "",
		};
	}

	/** Pull every block of `commit`'s CAR into the local cache. */
	private async loadCar(commitCid: CID, commit: CommitObject): Promise<void> {
		const bytes = await this.storage.getFile(commit.car);
		for (const block of await readCar(bytes)) {
			this.cache.set(block.cid.toString(), block.bytes);
		}
		this.loadedCars.add(commitCid.toString());
	}

	/**
	 * Resolve a data block: local cache first, then walk the commit chain from
	 * `hint`, loading one ancestor CAR at a time until the block turns up.
	 */
	private async getBlock(cid: CID, hint: CID | null): Promise<Uint8Array> {
		const key = cid.toString();
		const hit = this.cache.get(key);
		if (hit) return hit;

		let cursor = hint;
		while (cursor) {
			const commit = await this.getCommit(cursor);
			if (!this.loadedCars.has(cursor.toString())) {
				await this.loadCar(cursor, commit);
				const found = this.cache.get(key);
				if (found) return found;
			}
			cursor = commit.parents.length ? commit.parents[0] : null;
		}
		throw new Error(`Block payload missing for key: ${key}`);
	}

	private putLocal(block: Block): void {
		this.cache.set(block.cid.toString(), block.bytes);
	}

	// ── Commit-object layer ──────────────────────────────────────────────────
	//
	// The on-chain head is a *commit* CID digest. A commit wraps the root map
	// plus its parents and message, so the whole history is walkable from that
	// single trusted pointer.

	/**
	 * Reconstruct the current on-chain head of one publisher's namespace as a
	 * commit CID, or null if none. Each namespace is its own on-chain timeline,
	 * so this is per-(publisher, namespace) rather than per-publisher.
	 */
	async resolveHeadCommit(
		publisher: Address,
		namespace: NamespaceID,
	): Promise<CID | null> {
		const currentHead = await this.registryClient.getNamespaceHead(
			publisher,
			namespace,
		);
		if (currentHead === ZERO_BYTES32) return null;
		return this.hexToRootCid(currentHead);
	}

	/** Decode the root map behind a commit. */
	private async rootMapAt(commitCid: CID): Promise<RootMap> {
		const commit = await this.getCommit(commitCid);
		const raw = decodeBlock<Record<string, unknown>>(
			await this.getBlock(commit.root, commitCid),
		);
		const rootMap: RootMap = {};
		for (const [ns, link] of Object.entries(raw))
			rootMap[ns] = CID.parse(String(link));
		return rootMap;
	}

	/**
	 * Which namespace a commit belongs to, read from its root map.
	 *
	 * Each namespace is its own on-chain timeline, so a commit's root map carries
	 * exactly one entry — which is how an app-wide subscriber recovers the
	 * namespace *name* from a stream that only carries `keccak256(name)`. A commit
	 * with several entries predates per-namespace timelines and can't be
	 * attributed to one.
	 */
	async namespaceOf(rootHex: Hex): Promise<NamespaceID> {
		const names = Object.keys(await this.rootMapAt(this.hexToRootCid(rootHex)));
		if (names.length !== 1) {
			throw new Error(
				`commit ${rootHex} spans ${names.length.toString()} namespaces; expected exactly one`,
			);
		}
		return names[0];
	}

	/** The full vertex/edge link sets one commit records for `namespace`. */
	private async treeLinksAt(
		commitCid: CID,
		namespace: NamespaceID,
	): Promise<TreeLinks> {
		const rootMap = await this.rootMapAt(commitCid);
		if (!(namespace in rootMap))
			return { vertexLinks: [], edgeLinks: [], structureCids: new Set() };
		const treeLink = rootMap[namespace];

		const tree = decodeBlock<NamespaceTree>(
			await this.getBlock(treeLink, commitCid),
		);
		const get = (cid: CID) => this.getBlock(cid, commitCid);
		const vertexLinks = (
			await readPages(
				tree.vertices.map((c) => CID.parse(String(c))),
				get,
			)
		).map((c) => CID.parse(String(c)));
		const edgeLinks = (
			await readPages(
				tree.edges.map((c) => CID.parse(String(c))),
				get,
			)
		).map((c) => CID.parse(String(c)));
		const structureCids = new Set<string>([
			treeLink.toString(),
			...tree.vertices.map(String),
			...tree.edges.map(String),
		]);
		return { vertexLinks, edgeLinks, structureCids };
	}

	/**
	 * Build a new commit on top of `base` — entirely in memory, then persisted
	 * as exactly TWO uploads: one CAR file holding every block this commit
	 * introduced (git's packfile), and the small commit block itself (stored
	 * individually so the on-chain digest resolves without any index).
	 *
	 * The new namespace state is the parent state plus the staged graph;
	 * unchanged blocks are shared byte-for-byte with ancestors and are NOT
	 * re-uploaded. Does not touch the chain — `pushCommit` settles it.
	 */
	async createCommit(opts: CreateCommitOptions): Promise<{
		commitCid: CID;
		root: CID;
		vertexCids: Record<string, string>;
	}> {
		assertValidNamespace(opts.namespace);
		const { namespace, base } = opts;

		// Parent state for this namespace (empty for a root commit / new namespace).
		const rootMap: RootMap = base ? await this.rootMapAt(base) : {};
		const old: TreeLinks = base
			? await this.treeLinksAt(base, namespace)
			: { vertexLinks: [], edgeLinks: [], structureCids: new Set() };
		const oldVertexSet = new Set(old.vertexLinks.map(String));
		const oldEdgeSet = new Set(old.edgeLinks.map(String));

		// Stage vertices: encode each block; only blocks unseen at the parent
		// join the CAR delta. In replace mode the staged set IS the new state
		// (omitted entries are removed); the parent sets still gate the delta —
		// a re-staged unchanged block re-derives its old CID and isn't re-uploaded.
		const carBlocks: Block[] = [];
		const vertexCids: Record<string, string> = {};
		const idInfo = new Map<string, { cid: CID; tag: SchemaID }>();
		const vertexLinks = opts.replace ? [] : [...old.vertexLinks];
		const newVertexSet = new Set(vertexLinks.map(String));
		for (const v of opts.vertices) {
			if (!this.metagraph.validateVertex(namespace, v.schemaId, v.payload)) {
				throw new Error(
					`Schema violation for vertex type [${v.schemaId}] in namespace [${namespace}]`,
				);
			}
			const block = await encodeBlock({
				schemaId: v.schemaId,
				payload: v.payload,
			} satisfies VertexBlock);
			idInfo.set(v.id, { cid: block.cid, tag: v.schemaId });
			vertexCids[v.id] = block.cid.toString();
			const key = block.cid.toString();
			if (!newVertexSet.has(key)) {
				newVertexSet.add(key);
				vertexLinks.push(block.cid);
				// blocks already present at the parent never re-upload
				if (!oldVertexSet.has(key)) carBlocks.push(block);
			}
		}

		// Stage edges: endpoints resolve to vertices staged in this same call
		// (by local id) or to already-committed vertices (by full CID).
		const resolveEndpoint = (
			ref: string,
		): { cid: CID; tag: SchemaID | null } => {
			const info = idInfo.get(ref);
			if (info) return info;
			try {
				return { cid: CID.parse(ref), tag: null };
			} catch {
				throw new Error(
					`edge references unknown local id (or invalid CID): ${ref}`,
				);
			}
		};
		const edgeLinks = opts.replace ? [] : [...old.edgeLinks];
		const newEdgeSet = new Set(edgeLinks.map(String));
		for (const e of opts.edges) {
			const source = resolveEndpoint(e.from);
			const target = resolveEndpoint(e.to);
			// Schema rules only apply when both endpoint tags are known — a
			// CID-referenced endpoint's tag lives in an earlier commit.
			if (
				source.tag &&
				target.tag &&
				!this.metagraph.validateEdge(
					namespace,
					source.tag,
					e.relation,
					target.tag,
				)
			) {
				throw new Error(
					`Invalid structural link relation [${e.relation}] in namespace [${namespace}]`,
				);
			}
			const block = await encodeBlock({
				source: source.cid,
				relation: e.relation,
				target: target.cid,
			} satisfies EdgeBlock);
			const key = block.cid.toString();
			if (!newEdgeSet.has(key)) {
				newEdgeSet.add(key);
				edgeLinks.push(block.cid);
				if (!oldEdgeSet.has(key)) carBlocks.push(block);
			}
		}

		// Rebuild the namespace tree. Pages are deterministic over the sorted
		// link set, so untouched pages re-derive their old CID and drop out of
		// the delta.
		const { pages: vertexPages, pageLinks: vertexPageLinks } =
			await buildPages(vertexLinks);
		const { pages: edgePages, pageLinks: edgePageLinks } =
			await buildPages(edgeLinks);
		for (const page of [...vertexPages, ...edgePages]) {
			if (!old.structureCids.has(page.cid.toString())) carBlocks.push(page);
		}
		const treeBlock = await encodeBlock({
			vertices: vertexPageLinks,
			edges: edgePageLinks,
		} satisfies NamespaceTree);
		if (!old.structureCids.has(treeBlock.cid.toString()))
			carBlocks.push(treeBlock);

		const rootBlock = await encodeBlock({
			...rootMap,
			[namespace]: treeBlock.cid,
		});
		carBlocks.push(rootBlock);

		// Persist: one CAR upload for the delta, then the commit block naming it.
		for (const block of carBlocks) this.putLocal(block);
		const carBytes = await packCar(rootBlock.cid, carBlocks);
		const carUri = await this.storage.putFile(
			carBytes,
			`${rootBlock.cid.toString()}.car`,
		);

		const commitObj: CommitBlock = {
			root: rootBlock.cid,
			parents: base ? [base] : [],
			timestamp: Date.now(),
			message: opts.message,
			car: carUri,
		};
		const commitBlock = await encodeBlock(commitObj);
		await this.storage.putBlock(commitBlock);
		this.putLocal(commitBlock);
		this.loadedCars.add(commitBlock.cid.toString());

		return { commitCid: commitBlock.cid, root: rootBlock.cid, vertexCids };
	}

	/**
	 * Settle a local commit as the on-chain head of one namespace — the
	 * permissioned, git `push` step. The commit and its CAR are already durable
	 * in storage (createCommit uploads them), so this is just the compare-and-swap
	 * against the current head. Unless `force`, the on-chain head must be an
	 * ancestor of `commitCid` (fast-forward only).
	 */
	async pushCommit(
		publisher: Address,
		namespace: NamespaceID,
		commitCid: CID,
		opts?: { force?: boolean },
	): Promise<{ txHash: Hash; onChainTip: CID }> {
		const onChainHex = await this.registryClient.getNamespaceHead(
			publisher,
			namespace,
		);
		const onChainCommit =
			onChainHex === ZERO_BYTES32 ? null : this.hexToRootCid(onChainHex);

		if (
			!opts?.force &&
			onChainCommit &&
			onChainCommit.toString() !== commitCid.toString()
		) {
			if (!(await this.isAncestor(onChainCommit, commitCid))) {
				throw new Error(
					"non-fast-forward: the on-chain tip is not an ancestor of this commit — clone/rebuild onto the current tip, or push with force.",
				);
			}
		}

		const newRootHex = rootHexFromCid(commitCid);
		const txHash = await this.registryClient.commitStateRoot(
			namespace,
			onChainHex,
			newRootHex,
		);
		return { txHash, onChainTip: commitCid };
	}

	/** Walk the first-parent chain from `tip` toward the root, newest first. */
	async *walkParents(
		tip: CID,
		max?: number,
	): AsyncGenerator<{ cid: CID; commit: CommitObject }> {
		let cursor: CID | null = tip;
		for (let n = 0; cursor && (max === undefined || n < max); n++) {
			const commit = await this.getCommit(cursor);
			yield { cid: cursor, commit };
			cursor = commit.parents.length ? commit.parents[0] : null;
		}
	}

	/** True if `ancestor` appears on the first-parent chain of `tip`. */
	private async isAncestor(ancestor: CID, tip: CID): Promise<boolean> {
		const target = ancestor.toString();
		for await (const { cid } of this.walkParents(tip)) {
			if (cid.toString() === target) return true;
		}
		return false;
	}

	/** The commit CID string a raw on-chain root hex points at. */
	commitCidFromRootHex(hex: string): string {
		return this.hexToRootCid(hex).toString();
	}

	/** Inverse of `commitCidFromRootHex`: the on-chain root hex for a commit CID. */
	rootHexFromCommitCid(commitCid: string): Hex {
		return rootHexFromCid(CID.parse(commitCid));
	}

	/** Decode a vertex block into the public read shape. */
	private async decodeVertex(
		link: CID,
		hint: CID,
	): Promise<NamespaceContents["vertices"][number]> {
		const decoded = decodeBlock<VertexBlock>(await this.getBlock(link, hint));
		return {
			cid: link.toString(),
			schemaId: decoded.schemaId,
			payload: decoded.payload,
		};
	}

	/** Decode an edge block into the public read shape. */
	private async decodeEdge(link: CID, hint: CID): Promise<Edge> {
		const decoded = decodeBlock<EdgeBlock>(await this.getBlock(link, hint));
		return {
			sourceCid: String(decoded.source),
			relation: decoded.relation,
			targetCid: String(decoded.target),
		};
	}

	/**
	 * Net change to a single namespace between two on-chain roots — the core of
	 * the subscription light-client. Namespace trees are explicit link sets, so
	 * the diff is a plain set difference; only blocks that actually changed are
	 * decoded (each side resolves through its own commit's CAR chain).
	 *
	 * Diffing root-to-root (rather than walking commits) is deliberately robust:
	 * it yields the correct net delta even across a force-push / non-fast-forward
	 * reorg — exactly what an index builder needs (which vertices to (re)embed,
	 * which to evict).
	 */
	async namespaceDiff(
		oldRootHex: string | null,
		newRootHex: string,
		namespace: NamespaceID,
	): Promise<NamespaceDiff> {
		// A zero new root is a reset/tombstone-all: the after-state is empty and its
		// commit block (hexToRootCid(ZERO) = bafyreiaaaa…) is never stored, so it must
		// NOT be fetched — mirror the oldRoot ZERO_BYTES32 guard just below.
		const newCommit =
			newRootHex === ZERO_BYTES32 ? null : this.hexToRootCid(newRootHex);
		const oldCommit =
			oldRootHex && oldRootHex !== ZERO_BYTES32
				? this.hexToRootCid(oldRootHex)
				: null;

		const after = newCommit
			? await this.treeLinksAt(newCommit, namespace)
			: { vertexLinks: [] as CID[], edgeLinks: [] as CID[] };
		const before = oldCommit
			? await this.treeLinksAt(oldCommit, namespace)
			: { vertexLinks: [] as CID[], edgeLinks: [] as CID[] };

		const beforeV = new Set(before.vertexLinks.map(String));
		const beforeE = new Set(before.edgeLinks.map(String));
		const afterV = new Set(after.vertexLinks.map(String));
		const afterE = new Set(after.edgeLinks.map(String));

		const addedVertices: NamespaceContents["vertices"] = [];
		const addedEdges: Edge[] = [];

		// 1. Guard upfront to satisfy the compiler and ensure runtime safety
		if (after.vertexLinks.length > 0 || after.edgeLinks.length > 0) {
			if (!newCommit) {
				throw new Error("Missing commit context required to decode graph changes");
			}

			// TypeScript now safely knows newCommit is non-null for the rest of this block
			for (const link of after.vertexLinks) {
				if (!beforeV.has(link.toString())) {
					addedVertices.push(await this.decodeVertex(link, newCommit));
				}
			}

			for (const link of after.edgeLinks) {
				if (!beforeE.has(link.toString())) {
					addedEdges.push(await this.decodeEdge(link, newCommit));
				}
			}
		}

		const removedVertexCids = before.vertexLinks
			.map(String)
			.filter((c) => !afterV.has(c));
		const removedEdges: Edge[] = [];
		if (oldCommit) {
			// removed entries can only exist when there was an old root
			for (const link of before.edgeLinks) {
				if (!afterE.has(link.toString()))
					removedEdges.push(await this.decodeEdge(link, oldCommit));
			}
		}

		return { addedVertices, addedEdges, removedVertexCids, removedEdges };
	}

	/** Diff a commit against its first parent, across every namespace. */
	async diffCommit(commitCid: CID): Promise<CommitDiff> {
		const commit = await this.getCommit(commitCid);
		const parent = commit.parents.length ? commit.parents[0] : null;

		const childRoot = await this.rootMapAt(commitCid);
		const parentRoot = parent ? await this.rootMapAt(parent) : {};

		const added: string[] = [];
		const removed: string[] = [];
		const namespaces = new Set([
			...Object.keys(childRoot),
			...Object.keys(parentRoot),
		]);
		for (const ns of namespaces) {
			const inParent = ns in parentRoot;
			const inChild = ns in childRoot;
			// Unchanged tree link ⇒ identical namespace contents; skip the page walk.
			if (
				inParent &&
				inChild &&
				String(parentRoot[ns]) === String(childRoot[ns])
			)
				continue;

			const child = inChild
				? await this.treeLinksAt(commitCid, ns)
				: { vertexLinks: [] as CID[], edgeLinks: [] as CID[] };
			const par =
				parent && inParent
					? await this.treeLinksAt(parent, ns)
					: { vertexLinks: [] as CID[], edgeLinks: [] as CID[] };

			const parV = new Set(par.vertexLinks.map(String));
			const parE = new Set(par.edgeLinks.map(String));
			const childV = new Set(child.vertexLinks.map(String));
			const childE = new Set(child.edgeLinks.map(String));

			for (const c of childV) if (!parV.has(c)) added.push(`${ns}/v/${c}`);
			for (const c of childE) if (!parE.has(c)) added.push(`${ns}/e/${c}`);
			for (const c of parV) if (!childV.has(c)) removed.push(`${ns}/v/${c}`);
			for (const c of parE) if (!childE.has(c)) removed.push(`${ns}/e/${c}`);
		}

		return {
			message: commit.message,
			parents: commit.parents.map((c) => c.toString()),
			timestamp: commit.timestamp,
			root: commit.root.toString(),
			added: added.sort(),
			removed: removed.sort(),
		};
	}

	/** Has this publisher committed to this namespace on-chain yet? */
	async namespaceExists(
		namespace: NamespaceID,
		publisher: Address,
	): Promise<boolean> {
		const head = await this.resolveHeadCommit(publisher, namespace);
		if (!head) return false;
		const rootMap = await this.rootMapAt(head);
		return namespace in rootMap;
	}

	/** Lists every vertex and edge currently committed under a namespace, resolved from the on-chain root. */
	async listNamespace(
		namespace: NamespaceID,
		publisher: Address,
	): Promise<NamespaceContents> {
		const head = await this.resolveHeadCommit(publisher, namespace);
		if (!head) return { vertices: [], edges: [] };

		const { vertexLinks, edgeLinks } = await this.treeLinksAt(head, namespace);
		const vertices: NamespaceContents["vertices"] = [];
		for (const link of vertexLinks)
			vertices.push(await this.decodeVertex(link, head));
		const edges: Edge[] = [];
		for (const link of edgeLinks) edges.push(await this.decodeEdge(link, head));
		return { vertices, edges };
	}

	/**
	 * Fetch a single vertex by CID, resolving through the publisher's commit
	 * CAR chain (vertex blocks are not individually pinned — they live inside
	 * commit CARs).
	 */
	async readVertex(
		cid: string,
		publisher: Address,
		namespace: NamespaceID,
	): Promise<NamespaceContents["vertices"][number]> {
		const head = await this.resolveHeadCommit(publisher, namespace);
		if (!head)
			throw new Error(
				`publisher ${publisher} has no on-chain commits in namespace ${namespace}`,
			);
		return this.decodeVertex(CID.parse(cid), head);
	}
}
