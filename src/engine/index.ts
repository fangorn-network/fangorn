import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as Digest from "multiformats/hashes/digest";
import * as dagCbor from "@ipld/dag-cbor";
import {
	bytesToHex,
	hexToBytes,
	type Address,
	type Hash,
	type Hex,
} from "viem";
import {
	type CommitUpdate,
	type Registry,
	ZERO_HEAD,
	EMPTY_MMR,
	logLeaf,
	mmrAppend,
	mmrRoot,
	type Mmr,
} from "../contracts/index.js";
import { MetadataStorage } from "../providers/storage/types.js";
import {
	Block,
	CommitBlock,
	RecordBlock,
	assertBlockMatches,
	assertValidRecordId,
	buildMst,
	decodeBlock,
	encodeBlock,
	lookupMst,
	readMst,
	diffMst,
	type Stitch,
} from "./records.js";
import { packCar, readCar } from "./car.js";

export type { Ref, Stitch } from "./records.js";

export type RecordType = string;
export type RepoName = string;

/** A staged (typed) record */
export interface RecordInput {
	// a unique id for the record; randomly assigned on publish if empty
	id?: string;
	// the type of the record (for (de)serialization of the payload)
	type: RecordType;
	payload: Record<string, unknown>;
}

/** A published record */
export interface StoredRecord {
	id: string;
	// the content identifier of the record (bafy...)
	cid: string;
	type: RecordType;
	payload: Record<string, unknown>;
}

/**
 * A decoded commit: the event (e, parent, diff, root) plus its repo name and CAR
 * (see CommitBlock). `diff` is null for commits written before events carried one.
 */
export type CommitObject = Omit<CommitBlock, "diff"> & { diff: CID | null };

export interface RepoContents {
	records: StoredRecord[];
}

/** Net change to a repo between two roots. */
export interface RepoDiff {
	/** Records that are new, or whose content changed (same id, new cid). */
	puts: StoredRecord[];
	/** Ids of records that are gone. */
	deletes: string[];
	/** CIDs of the old versions: records deleted, or replaced by a put. An index keyed by record CID drops these. */
	superseded: string[];
}

const ZERO_BYTES32 = ZERO_HEAD;

/**
 * Upper bound on a repo name's length. The name is stored in every commit
 * block, so this is just a sanity bound keeping that block small and
 * rejecting garbage input early.
 */
export const MAX_REPO_NAME_LENGTH = 256;

/**
 * The root of the graph, committed to IPFS, as hex
 */
export function rootHexFromCid(commitCid: CID): Hex {
	return bytesToHex(commitCid.multihash.digest);
}

/** The dag-cbor CID of a commit (or any block) from its bare sha256 digest, as the registry stores heads. */
/** A stitch block (see `restitch`): stored on its own, like a commit. */
interface StitchBlock {
	parent: CID | null;
	root: CID;
	car: CID | null;
	/** log entries folded in, and the mountain range's peaks after them */
	n: number;
	peaks: (Hex | null)[];
	/** the clock it read the log up to: where the next stitch resumes */
	t: number;
}

/** A repo's key in a stitch across repos. */
const stitchKey = (publisher: Address, repo: string) =>
	`${publisher.toLowerCase()}/${repo}`;

export function cidFromDigest(digest: Hex): CID {
	return CID.createV1(
		dagCbor.code,
		Digest.create(sha256.code, hexToBytes(digest)),
	);
}

/** The update that settles `commit`. */
export function commitUpdate(commit: CommitObject): CommitUpdate {
	if (!commit.diff)
		throw new Error(
			"commit has no diff: it is not in the current commit format — rebuild it",
		);
	return {
		repo: commit.repo,
		epoch: commit.epoch,
		parent: commit.parent ? rootHexFromCid(commit.parent) : ZERO_HEAD,
		diff: rootHexFromCid(commit.diff),
		root: rootHexFromCid(commit.root),
		car: bytesToHex(commit.car.bytes),
	};
}

/** The head the registry computes for `u`. */
export async function commitHead(u: CommitUpdate): Promise<Hex> {
	const link = cidFromDigest;
	const block = await encodeBlock({
		epoch: u.epoch,
		parent: u.parent === ZERO_HEAD ? null : link(u.parent),
		diff: link(u.diff),
		root: link(u.root),
		repo: u.repo,
		car: CID.decode(hexToBytes(u.car)),
	} satisfies CommitBlock);
	return rootHexFromCid(block.cid);
}

/** A commit's update, signed by its publisher for anyone to submit. */
export interface SignedUpdate {
	publisher: Address;
	update: CommitUpdate;
	signature: Hex;
}

/** The CID a storage backend returned for a file, with or without an `ipfs://` prefix. */
export function fileCid(uri: string): CID {
	try {
		return CID.parse(uri.replace(/^ipfs:\/\//, ""));
	} catch {
		throw new Error(
			`storage returned ${JSON.stringify(uri)} for a CAR file; expected its CID`,
		);
	}
}

/** Repos must be non-empty strings whose length does not exceed MAX_REPO_NAME_LENGTH */
export function assertValidRepoName(repo: RepoName): void {
	if (typeof repo !== "string" || repo.length === 0) {
		throw new Error("repo must be a non-empty string");
	}
	if (repo.length > MAX_REPO_NAME_LENGTH) {
		throw new Error(
			`repo exceeds the maximum length of ${MAX_REPO_NAME_LENGTH.toString()} characters ` +
				`(got ${repo.length.toString()}).`,
		);
	}
}

/** One line of a commit's diff against its parent. */
export interface CommitDiff {
	parent: string | null;
	epoch: number;
	repo: string;
	root: string;
	/** `<ns>/<id>` of records new vs. the parent. */
	added: string[];
	/** `<ns>/<id>` of records whose content changed. */
	updated: string[];
	/** `<ns>/<id>` of records present in the parent but gone in this commit. */
	removed: string[];
}

/** Input to `createCommit`: puts and deletes, by record id, under one repo. */
export interface CreateCommitOptions {
	repo: RepoName;
	/** Parent commit this builds on (local HEAD or on-chain tip), or null for a root commit. */
	base: CID | null;
	/** Records to put. A put replaces any record with the same id. */
	records: RecordInput[];
	/** Ids of records to remove. Applied before `records`. */
	deletes?: string[];
	/**
	 * When true, the staged records REPLACE the repo's previous contents
	 * (a snapshot commit — anything omitted is removed). Default: puts and
	 * deletes apply on top of the parent state.
	 */
	// TODO: needed?
	replace?: boolean;
}

/** One repo's state at a commit: id → record CID, plus its MST node CIDs. */
interface RepoState {
	state: Map<string, CID>;
	nodeCids: Set<string>;
}

const EMPTY_STATE: RepoState = { state: new Map(), nodeCids: new Set() };

export class FangornEngine {
	/**
	 * Local block cache. Written blocks land here immediately; remote blocks
	 * are pulled in whole-CAR-at-a-time by `loadCar`. Content addressing makes
	 * the cache trivially coherent.
	 */
	private cache = new Map<string, Uint8Array>();
	/** Commits whose CAR has already been loaded into the cache. */
	private loadedCars = new Set<string>();
	/**
	 * Blocks from a loaded CAR, not yet hash-checked. A CAR holds every block its commit introduced
	 * (the first commit of a 50k-record repo: all of them), and a diff reads a handful: each block is
	 * checked when `getBlock` first hands it out, then moves to `cache`.
	 */
	private unverified = new Map<string, Uint8Array>();

	constructor(
		private storage: MetadataStorage,
		private registry: Registry,
	) {}

	/**
	 * Reconstructs the CID a commit's raw digest hex refers to. The contract only
	 * stores the bare 32-byte sha256 digest (see commitStateRoot), so rebuilding
	 * the CID must wrap that digest directly via Digest.create — hashing it again
	 * with sha256.digest() would produce an unrelated CID pointing at nothing.
	 */
	private hexToRootCid(hex: string): CID {
		const cleanHex = hex.startsWith("0x") ? hex.slice(2) : hex;
		const rawDigestBytes = hexToBytes(`0x${cleanHex}`);
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
		const bytes = await this.directBlock(commitCid);
		const decoded = decodeBlock<Partial<CommitBlock>>(bytes);
		if (typeof decoded.epoch !== "number" || typeof decoded.repo !== "string") {
			throw new Error(
				`commit ${key} predates the (e, parent, root) commit format. ` +
					"Reset the on-chain head (`fangorn reset`) and re-publish.",
			);
		}
		return {
			epoch: decoded.epoch,
			parent: decoded.parent ? CID.parse(String(decoded.parent)) : null,
			diff: decoded.diff ? CID.parse(String(decoded.diff)) : null,
			root: CID.parse(String(decoded.root)),
			repo: decoded.repo,
			car: CID.parse(String(decoded.car)),
		};
	}

	/** A block stored on its own (a commit or stitch block), hash-checked and cached. */
	private async directBlock(cid: CID): Promise<Uint8Array> {
		const key = cid.toString();
		let bytes = this.cache.get(key);
		if (!bytes) {
			bytes = await this.storage.getRawBlock(key);
			assertBlockMatches(cid, bytes);
			this.cache.set(key, bytes);
		}
		return bytes;
	}

	/** The packfile and parent of a link in a chain: a commit, or a stitch. */
	private async chainLink(
		cid: CID,
	): Promise<{ car: CID | null; parent: CID | null }> {
		const b = decodeBlock<{ car?: CID | null; parent?: CID | null }>(
			await this.directBlock(cid),
		);
		return { car: b.car ?? null, parent: b.parent ?? null };
	}

	/** Pull every block of a chain link's CAR into the local cache. */
	private async loadCar(linkCid: CID, car: CID | null): Promise<void> {
		if (car) {
			const bytes = await this.storage.getFile(car.toString());
			for (const block of await readCar(bytes, { verify: false })) {
				const key = block.cid.toString();
				if (!this.cache.has(key)) this.unverified.set(key, block.bytes);
			}
		}
		this.loadedCars.add(linkCid.toString());
	}

	/**
	 * Resolve a data block: local cache first, then walk the chain (commits, or
	 * stitches) from `hint`, loading one ancestor CAR at a time until the block turns up.
	 */
	private async getBlock(cid: CID, hint: CID | null): Promise<Uint8Array> {
		const key = cid.toString();
		const local = () => {
			const hit = this.cache.get(key);
			if (hit) return hit;
			const raw = this.unverified.get(key);
			if (!raw) return null;
			assertBlockMatches(cid, raw);
			this.unverified.delete(key);
			this.cache.set(key, raw);
			return raw;
		};
		const hit = local();
		if (hit) return hit;

		let cursor = hint;
		while (cursor) {
			const link = await this.chainLink(cursor);
			if (!this.loadedCars.has(cursor.toString())) {
				await this.loadCar(cursor, link.car);
				const found = local();
				if (found) return found;
			}
			cursor = link.parent;
		}
		throw new Error(`Block payload missing for key: ${key}`);
	}

	private putLocal(block: Block): void {
		this.cache.set(block.cid.toString(), block.bytes);
	}

	// ── Commit-object layer ──────────────────────────────────────────────────
	//
	// The on-chain head is a *commit* CID digest. A commit names its parent and
	// its state root, so the whole history is walkable from that one pointer.

	/**
	 * Reconstruct the current on-chain head of one publisher's repo as a
	 * commit CID, or null if none. Each repo is its own on-chain timeline,
	 * so this is per-(publisher, repo) rather than per-publisher.
	 */
	async resolveHeadCommit(
		publisher: Address,
		repo: RepoName,
	): Promise<CID | null> {
		const currentHead = await this.registry.head({ publisher, repo });
		if (currentHead === ZERO_BYTES32) return null;
		return this.hexToRootCid(currentHead);
	}

	/**
	 * Which repo a commit belongs to. Events carry only `keccak256(name)`, so
	 * this is how a subscriber to every repo recovers the name.
	 */
	async repoOf(rootHex: Hex): Promise<RepoName> {
		return (await this.getCommit(this.hexToRootCid(rootHex))).repo;
	}

	/** The record state a commit holds. */
	private async stateAt(commitCid: CID): Promise<RepoState> {
		const commit = await this.getCommit(commitCid);
		return readMst(commit.root, (cid) => this.getBlock(cid, commitCid));
	}

	/**
	 * Build a new commit on top of `base` — entirely in memory, then persisted
	 * as exactly TWO uploads: one CAR file holding every block this commit
	 * introduced (git's packfile), and the small commit block itself (stored
	 * individually so the on-chain digest resolves without any index).
	 *
	 * Unchanged records and MST nodes re-derive their old CIDs and are NOT
	 * re-uploaded. Does not touch the chain — `pushCommit` settles it.
	 */
	async createCommit(opts: CreateCommitOptions): Promise<{
		commitCid: CID;
		root: CID;
		/** id → record CID for every record staged (including generated ids). */
		recordCids: Record<string, string>;
	}> {
		assertValidRepoName(opts.repo);
		const { repo, base } = opts;

		// Parent state (empty for a root commit / new repo).
		if (base && (await this.getCommit(base)).repo !== repo) {
			throw new Error(
				`commit ${base.toString()} belongs to another repo than ${repo}`,
			);
		}
		const old = base ? await this.stateAt(base) : EMPTY_STATE;
		const oldRecordCids = new Set([...old.state.values()].map(String));

		const state = opts.replace ? new Map<string, CID>() : new Map(old.state);
		for (const id of opts.deletes ?? []) state.delete(id);

		const carBlocks: Block[] = [];
		const recordCids: Record<string, string> = {};
		for (const r of opts.records) {
			const id = r.id ?? globalThis.crypto.randomUUID();
			assertValidRecordId(id);
			if (id in recordCids) throw new Error(`record id ${id} staged twice`);
			const block = await encodeBlock({
				id,
				type: r.type,
				payload: r.payload,
			} satisfies RecordBlock);
			state.set(id, block.cid);
			recordCids[id] = block.cid.toString();
			// a record unchanged since the parent is already stored
			if (!oldRecordCids.has(block.cid.toString())) carBlocks.push(block);
		}

		// Rebuild the tree; only nodes on changed paths have new CIDs.
		const mst = await buildMst(state);
		// The event's diff: every id whose record changed, null where it is gone.
		const delta = new Map<string, CID | null>();
		for (const [id, cid] of state)
			if (!old.state.get(id)?.equals(cid)) delta.set(id, cid);
		for (const id of old.state.keys()) if (!state.has(id)) delta.set(id, null);
		const diff = await buildMst(delta);
		const fresh = new Set<string>();
		for (const node of [...mst.nodes, ...diff.nodes]) {
			const key = node.cid.toString();
			if (!old.nodeCids.has(key) && !fresh.has(key)) {
				fresh.add(key);
				carBlocks.push(node);
			}
		}

		// Persist: one CAR upload for the delta, then the commit block naming it.
		for (const block of carBlocks) this.putLocal(block);
		const carBytes = await packCar(mst.root, carBlocks);
		const car = fileCid(
			await this.storage.putFile(carBytes, `${mst.root.toString()}.car`),
		);

		const commitObj: CommitBlock = {
			epoch: await this.registry.epoch(),
			parent: base,
			diff: diff.root,
			root: mst.root,
			repo,
			car,
		};
		const commitBlock = await encodeBlock(commitObj);
		await this.storage.putBlock(commitBlock);
		this.putLocal(commitBlock);
		this.loadedCars.add(commitBlock.cid.toString());

		return { commitCid: commitBlock.cid, root: mst.root, recordCids };
	}

	/**
	 * Settle a local commit as the on-chain head of one repo — the `update` of
	 * WHITEPAPER_1 §3.2. The commit and its CAR are already durable in storage
	 * (createCommit uploads them), so this is just the compare-and-swap.
	 */
	async pushCommit(
		publisher: Address,
		repo: RepoName,
		commitCid: CID,
	): Promise<{ txHash: Hash; onChainTip: CID }> {
		const update = await this.settleable(publisher, repo, commitCid);
		return {
			txHash: await this.registry.update(update),
			onChainTip: commitCid,
		};
	}

	/** `pushCommit`, signed by this registry's wallet for anyone to submit with `relayCommit`. */
	async signCommit(
		publisher: Address,
		repo: RepoName,
		commitCid: CID,
	): Promise<SignedUpdate> {
		const update = await this.settleable(publisher, repo, commitCid);
		return {
			publisher,
			update,
			signature: await this.registry.signUpdate(update),
		};
	}

	relayCommit(s: SignedUpdate): Promise<Hash> {
		return this.registry.updateBySig(s.publisher, s.update, s.signature);
	}

	/** The update for `commitCid`, once it is one the registry will take as the next head. */
	async settleable(
		publisher: Address,
		repo: RepoName,
		commitCid: CID,
	): Promise<CommitUpdate> {
		const commit = await this.getCommit(commitCid);
		if (commit.repo !== repo) {
			throw new Error(
				`commit ${commitCid.toString()} is a commit of ${commit.repo}, not ${repo}`,
			);
		}
		const update = commitUpdate(commit);
		if (update.parent !== (await this.registry.head({ publisher, repo }))) {
			throw new Error(
				"stale parent: this commit's parent is not the on-chain head — rebuild it onto the current head.",
			);
		}
		if ((await commitHead(update)) !== rootHexFromCid(commitCid)) {
			throw new Error(
				`commit ${commitCid.toString()} is not in the current commit format — rebuild it`,
			);
		}
		return update;
	}

	/** Walk the parent chain from `tip` toward the root, newest first. */
	async *walkParents(
		tip: CID,
		max?: number,
	): AsyncGenerator<{ cid: CID; commit: CommitObject }> {
		let cursor: CID | null = tip;
		for (let n = 0; cursor && (max === undefined || n < max); n++) {
			const commit = await this.getCommit(cursor);
			yield { cid: cursor, commit };
			cursor = commit.parent;
		}
	}

	/** The commit CID string a raw on-chain root hex points at. */
	commitCidFromRootHex(hex: string): string {
		return this.hexToRootCid(hex).toString();
	}

	/** Inverse of `commitCidFromRootHex`: the on-chain root hex for a commit CID. */
	rootHexFromCommitCid(commitCid: string): Hex {
		return rootHexFromCid(CID.parse(commitCid));
	}

	/** Decode a record block, checking it is filed under its own id. */
	private async decodeRecord(
		id: string,
		link: CID,
		hint: CID,
	): Promise<StoredRecord> {
		const r = decodeBlock<RecordBlock>(await this.getBlock(link, hint));
		if (r.id !== id) {
			throw new Error(
				`record ${link.toString()} has id ${r.id}, filed under ${id}`,
			);
		}
		return { id, cid: link.toString(), type: r.type, payload: r.payload };
	}

	/** The diff an event carries: id → new record CID, or null where the record was deleted. */
	async eventDiff(commitCid: CID): Promise<Map<string, CID | null>> {
		const { diff } = await this.getCommit(commitCid);
		if (!diff)
			throw new Error(`commit ${commitCid.toString()} predates diff events`);
		return (
			await readMst<CID | null>(diff, (cid) => this.getBlock(cid, commitCid))
		).state;
	}

	/**
	 * The events after `old` up to `tip`, composed into one id → CID | null map, newest write
	 * winning. Null when `old` is not an ancestor of `tip`, or an event between them has no diff.
	 */
	private async eventsSince(
		old: CID,
		tip: CID,
	): Promise<Map<string, CID | null> | null> {
		// Commit blocks are small and loose: find the path first, then open CARs for its diffs.
		const path: CID[] = [];
		for await (const { cid, commit } of this.walkParents(tip)) {
			if (cid.equals(old)) break;
			if (!commit.diff || !commit.parent) return null;
			path.push(cid);
		}
		const net = new Map<string, CID | null>();
		for (const cid of path)
			for (const [id, v] of await this.eventDiff(cid))
				if (!net.has(id)) net.set(id, v);
		return net;
	}

	/**
	 * Net change to a single repo between two on-chain roots — the core of
	 * the subscription light-client. Only records that actually changed are decoded.
	 *
	 * When `old` is an ancestor of `new`, this reads the diffs the events carry (WHITEPAPER_1 §3.3,
	 * Following) and looks each changed id up in the old tree. Otherwise, across a reset to another
	 * chain or a commit from before diff events, it diffs the two trees (`diffMst`). Either way the
	 * result is the net delta an index builder needs: what to (re)embed, what to evict.
	 */
	async repoDiff(
		oldRootHex: string | null,
		newRootHex: string,
	): Promise<RepoDiff> {
		// A zero new root is a reset/tombstone-all: the after-state is empty and its
		// commit block (hexToRootCid(ZERO) = bafyreiaaaa…) is never stored, so it must
		// NOT be fetched — mirror the oldRoot ZERO_BYTES32 guard just below.
		const newCommit =
			newRootHex === ZERO_BYTES32 ? null : this.hexToRootCid(newRootHex);
		const oldCommit =
			oldRootHex && oldRootHex !== ZERO_BYTES32
				? this.hexToRootCid(oldRootHex)
				: null;

		const events =
			oldCommit && newCommit
				? await this.eventsSince(oldCommit, newCommit)
				: null;
		if (oldCommit && newCommit && events) {
			const oldRoot = (await this.getCommit(oldCommit)).root;
			const puts: StoredRecord[] = [];
			const deletes: string[] = [];
			const superseded: string[] = [];
			for (const [id, after] of events) {
				const before = await lookupMst(oldRoot, id, (cid) =>
					this.getBlock(cid, oldCommit),
				);
				if (before && after && before.equals(after)) continue;
				if (before) superseded.push(before.toString());
				if (after) puts.push(await this.decodeRecord(id, after, newCommit));
				else if (before) deletes.push(id);
			}
			return { puts, deletes, superseded };
		}

		const root = async (c: CID | null) =>
			c ? (await this.getCommit(c)).root : null;
		const diff = await diffMst(
			await root(oldCommit),
			await root(newCommit),
			(cid) => this.getBlock(cid, oldCommit),
			(cid) => this.getBlock(cid, newCommit),
		);
		const puts: StoredRecord[] = [];
		if (newCommit)
			for (const [id, cid] of diff.puts)
				puts.push(await this.decodeRecord(id, cid, newCommit));
		return {
			puts,
			deletes: diff.deletes,
			superseded: [...diff.before.values()].map(String),
		};
	}

	/** Diff a commit against its parent: its event's diff, or two full states for an older commit. */
	async diffCommit(commitCid: CID): Promise<CommitDiff> {
		const commit = await this.getCommit(commitCid);
		const ns = commit.repo;
		const added: string[] = [];
		const updated: string[] = [];
		const removed: string[] = [];

		if (commit.diff) {
			const parent = commit.parent;
			const parentRoot = parent ? (await this.getCommit(parent)).root : null;
			for (const [id, cid] of await this.eventDiff(commitCid)) {
				if (!cid) removed.push(`${ns}/${id}`);
				else if (
					parent &&
					parentRoot &&
					(await lookupMst(parentRoot, id, (c) => this.getBlock(c, parent)))
				)
					updated.push(`${ns}/${id}`);
				else added.push(`${ns}/${id}`);
			}
		} else {
			const child = (await this.stateAt(commitCid)).state;
			const par = commit.parent
				? (await this.stateAt(commit.parent)).state
				: new Map<string, CID>();
			for (const [id, cid] of child) {
				const prev = par.get(id);
				if (!prev) added.push(`${ns}/${id}`);
				else if (!prev.equals(cid)) updated.push(`${ns}/${id}`);
			}
			for (const id of par.keys())
				if (!child.has(id)) removed.push(`${ns}/${id}`);
		}

		return {
			parent: commit.parent?.toString() ?? null,
			epoch: commit.epoch,
			repo: ns,
			root: commit.root.toString(),
			added: added.sort(),
			updated: updated.sort(),
			removed: removed.sort(),
		};
	}

	/** A stitch to the current head of (publisher, repo), at `key` if given. One `getHead` read, no logs. */
	async stitchTo(
		publisher: Address,
		repo: RepoName,
		key?: string,
	): Promise<Stitch> {
		const { pos, head } = await this.registry.headAt({ publisher, repo });
		if (pos === 0) throw new Error(`${publisher} has no head in repo ${repo}`);
		return {
			publisher,
			repo,
			pos,
			head,
			...(key === undefined ? {} : { key }),
		};
	}

	/**
	 * A stitch across repos: an MST of `publisher/repo` → head commit, folded from the
	 * update log up to entry n and tagged with the log's root there. Pass the previous
	 * stitch to read only the log since it, and upload only the nodes it doesn't have
	 * (one CAR). Returns the stitch block's CID, its name; with nothing new, `prev`.
	 * Use the same `filter` every time for one stitch. `fromBlock` is where the log
	 * starts (the registry's deploy block).
	 * ponytail: rehashes the whole tree (O(repos)); and readers walk back one CAR per
	 * stitch to find old nodes, so checkpoint with a full CAR (`prev = null`) when the
	 * chain gets long.
	 */
	async restitch(
		prev: CID | null,
		filter?: (publisher: Address, repo: RepoName) => boolean,
		fromBlock = 0n,
	): Promise<CID> {
		const base = prev ? await this.readStitch(prev) : null;
		const to = await this.registry.clock();
		const entries = await this.registry.log(
			{},
			base ? base.t + 1n : fromBlock,
			to,
		);
		if (prev && entries.length === 0) return prev;

		const old =
			base && prev
				? await readMst(base.root, (c) => this.getBlock(c, prev))
				: { state: new Map<string, CID>(), nodeCids: new Set<string>() };
		const state = new Map<string, CID | null>(old.state);
		let mmr: Mmr = base ?? EMPTY_MMR;
		for (const e of entries) {
			mmr = mmrAppend(mmr, logLeaf(e));
			if (!filter || filter(e.publisher, e.repo))
				state.set(stitchKey(e.publisher, e.repo), this.hexToRootCid(e.head));
		}

		const { root, nodes } = await buildMst(state);
		const fresh = new Map<string, Block>();
		for (const n of nodes)
			if (!old.nodeCids.has(n.cid.toString())) fresh.set(n.cid.toString(), n);
		for (const n of fresh.values()) this.putLocal(n);
		const car = fresh.size
			? fileCid(
					await this.storage.putFile(
						await packCar(root, fresh.values()),
						`${root.toString()}.car`,
					),
				)
			: null;
		const block = await encodeBlock({
			parent: prev,
			root,
			car,
			n: mmr.n,
			t: Number(to),
			peaks: mmr.peaks,
		} satisfies StitchBlock);
		await this.storage.putBlock(block);
		this.putLocal(block);
		this.loadedCars.add(block.cid.toString());
		return block.cid;
	}

	/** A stitch block: its tree root, and the log it was folded from (n entries, root `logRoot`). */
	async readStitch(stitch: CID): Promise<{
		root: CID;
		n: number;
		t: bigint;
		peaks: (Hex | null)[];
		logRoot: Hex;
	}> {
		const b = decodeBlock<StitchBlock>(await this.directBlock(stitch));
		const mmr = { n: b.n, peaks: b.peaks };
		return {
			root: CID.parse(String(b.root)),
			...mmr,
			t: BigInt(b.t),
			logRoot: mmrRoot(mmr),
		};
	}

	/**
	 * The head commit a stitch holds for (publisher, repo), or null if it doesn't
	 * include the repo. Every node read is hash-checked.
	 * ponytail: like `lookupMst`, trusts key order on the path; `readMst` proves absence.
	 */
	async stitchedHead(
		stitch: CID,
		publisher: Address,
		repo: RepoName,
	): Promise<CID | null> {
		const { root } = await this.readStitch(stitch);
		return lookupMst(root, stitchKey(publisher, repo), (c) =>
			this.getBlock(c, stitch),
		);
	}

	/**
	 * Check a stitch without trusting whoever built it: replay the whole log, check it
	 * against the contract's log root, and rebuild the stitch from its first n entries
	 * under the same `filter`. Reads no stitch nodes, only the stitch block.
	 * ponytail: O(log) per check; store log roots on chain if that gets slow.
	 */
	async verifyStitch(
		stitch: CID,
		filter?: (publisher: Address, repo: RepoName) => boolean,
		fromBlock = 0n,
	): Promise<boolean> {
		const s = await this.readStitch(stitch);
		const to = await this.registry.clock();
		const entries = await this.registry.log({}, fromBlock, to);
		if (entries.length < s.n) return false;
		let mmr = EMPTY_MMR;
		const state = new Map<string, CID | null>();
		for (const [i, e] of entries.entries()) {
			mmr = mmrAppend(mmr, logLeaf(e));
			if (i >= s.n) continue;
			if (!filter || filter(e.publisher, e.repo))
				state.set(stitchKey(e.publisher, e.repo), this.hexToRootCid(e.head));
			if (i === s.n - 1 && mmrRoot(mmr) !== s.logRoot) return false;
		}
		if (s.n === 0 && s.logRoot !== mmrRoot(EMPTY_MMR)) return false;
		if (mmrRoot(mmr) !== (await this.registry.logRoot(to))) return false;
		return (await buildMst(state)).root.equals(s.root);
	}

	/**
	 * Check a stitch against the registry (WHITEPAPER_1 Proposition 4.2) and resolve it:
	 * the record at its key as of that position (null if absent), or, with no key, the event's diff.
	 * Throws if the repo never had `head` at `pos`. `latest` says whether the repo has moved on.
	 * A stitch at the current generation is checked with one `getHead` read.
	 * ponytail: an older stitch still scans the log from `fromBlock` (and trusts the RPC).
	 * Upgrade: walk parents back from the on-chain head, recomputing `commitHead` each hop
	 * (O(distance), no logs), or an MMR opening against `logRoot()` (O(log n), needs a proof server).
	 */
	async checkStitch(
		s: Stitch,
		fromBlock = 0n,
	): Promise<{
		latest: boolean;
		record?: StoredRecord | null;
		diff?: Map<string, CID | null>;
	}> {
		const ref = { publisher: s.publisher, repo: s.repo };
		const cur = await this.registry.headAt(ref);
		if (s.pos < 1 || s.pos > cur.pos)
			throw new Error(
				`no position ${s.pos.toString()} in ${s.publisher}/${s.repo}`,
			);
		const latest = s.pos === cur.pos;
		const had = latest
			? cur.head
			: (await this.registry.log(ref, fromBlock)).find((e) => e.pos === s.pos)
					?.head;
		if (had?.toLowerCase() !== s.head.toLowerCase())
			throw new Error(
				`false stitch: ${s.publisher}/${s.repo} had ${had ?? "nothing"} at position ${s.pos.toString()}, not ${s.head}`,
			);
		const commit = this.hexToRootCid(s.head);
		if (s.key === undefined)
			return { latest, diff: await this.eventDiff(commit) };
		const cid = await lookupMst(
			(await this.getCommit(commit)).root,
			s.key,
			(c) => this.getBlock(c, commit),
		);
		return {
			latest,
			record: cid ? await this.decodeRecord(s.key, cid, commit) : null,
		};
	}

	/** check if the repo already exists (head resolves) */
	async repoExists(publisher: Address, repo: RepoName): Promise<boolean> {
		return (await this.resolveHeadCommit(publisher, repo)) !== null;
	}

	/** Lists every record currently committed under a repo, resolved from the on-chain root. */
	async listRepo(publisher: Address, repo: RepoName): Promise<RepoContents> {
		return this.listAt(await this.resolveHeadCommit(publisher, repo));
	}

	/** Every record in the state a commit holds; none for no commit. */
	async listAt(head: CID | null): Promise<RepoContents> {
		if (!head) return { records: [] };
		const { state } = await this.stateAt(head);
		const records: StoredRecord[] = [];
		for (const [id, cid] of state)
			records.push(await this.decodeRecord(id, cid, head));
		return { records };
	}

	/**
	 * Fetch the current version of one record by id — one MST path from the
	 * on-chain root, then the record block. Null if the repo has no such id.
	 */
	async readRecord(
		publisher: Address,
		repo: RepoName,
		id: string,
	): Promise<StoredRecord | null> {
		const head = await this.resolveHeadCommit(publisher, repo);
		if (!head)
			throw new Error(
				`publisher ${publisher} has no on-chain commits in repo ${repo}`,
			);
		const get = (cid: CID) => this.getBlock(cid, head);
		const cid = await lookupMst((await this.getCommit(head)).root, id, get);
		return cid ? this.decodeRecord(id, cid, head) : null;
	}
}
