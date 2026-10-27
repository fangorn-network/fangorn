import { randomUUID } from "crypto";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as Digest from "multiformats/hashes/digest";
import { type Address, type Hash, type Hex } from "viem";
import { type Registry, ZERO_HEAD } from "../registry.js";
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
} from "./records.js";
import { packCar, readCar } from "./car.js";

export type { Ref } from "./records.js";

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

/** A decoded commit, γ = (e, parent, root) plus its repo name, message and CAR (see CommitBlock). */
export type CommitObject = CommitBlock;

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
	return `0x${Buffer.from(commitCid.multihash.digest).toString("hex")}`;
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
	message: string;
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
	message: string;
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
			assertBlockMatches(commitCid, bytes);
			this.cache.set(key, bytes);
		}

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
			root: CID.parse(String(decoded.root)),
			repo: decoded.repo,
			message: decoded.message ?? "",
			car: decoded.car ?? "",
		};
	}

	/** Pull every block of `commit`'s CAR into the local cache. */
	private async loadCar(commitCid: CID, commit: CommitObject): Promise<void> {
		const bytes = await this.storage.getFile(commit.car);
		for (const block of await readCar(bytes, { verify: false })) {
			const key = block.cid.toString();
			if (!this.cache.has(key)) this.unverified.set(key, block.bytes);
		}
		this.loadedCars.add(commitCid.toString());
	}

	/**
	 * Resolve a data block: local cache first, then walk the commit chain from
	 * `hint`, loading one ancestor CAR at a time until the block turns up.
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
			const commit = await this.getCommit(cursor);
			if (!this.loadedCars.has(cursor.toString())) {
				await this.loadCar(cursor, commit);
				const found = local();
				if (found) return found;
			}
			cursor = commit.parent;
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
	 * this is how an app-wide subscriber recovers the name.
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
			throw new Error(`commit ${base.toString()} belongs to another repo than ${repo}`);
		}
		const old = base ? await this.stateAt(base) : EMPTY_STATE;
		const oldRecordCids = new Set([...old.state.values()].map(String));

		const state = opts.replace ? new Map<string, CID>() : new Map(old.state);
		for (const id of opts.deletes ?? []) state.delete(id);

		const carBlocks: Block[] = [];
		const recordCids: Record<string, string> = {};
		for (const r of opts.records) {
			const id = r.id ?? randomUUID();
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
		for (const node of mst.nodes) {
			if (!old.nodeCids.has(node.cid.toString())) carBlocks.push(node);
		}

		// Persist: one CAR upload for the delta, then the commit block naming it.
		for (const block of carBlocks) this.putLocal(block);
		const carBytes = await packCar(mst.root, carBlocks);
		const carUri = await this.storage.putFile(
			carBytes,
			`${mst.root.toString()}.car`,
		);

		const commitObj: CommitBlock = {
			epoch: await this.registry.epoch(),
			parent: base,
			root: mst.root,
			repo,
			message: opts.message,
			car: carUri,
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
	 *
	 * The commit's parent must BE the current head, not merely an ancestor of
	 * it: then the parent chain and the registry's log are one history
	 * (Theorem 3). Today's contract only checks the old root, so the parent is
	 * checked here.
	 */
	async pushCommit(
		publisher: Address,
		repo: RepoName,
		commitCid: CID,
	): Promise<{ txHash: Hash; onChainTip: CID }> {
		const head = await this.registry.head({ publisher, repo });
		const commit = await this.getCommit(commitCid);
		const parentHex = commit.parent ? rootHexFromCid(commit.parent) : ZERO_BYTES32;
		if (commit.repo !== repo) {
			throw new Error(`commit ${commitCid.toString()} is a commit of ${commit.repo}, not ${repo}`);
		}
		if (parentHex !== head) {
			throw new Error(
				"stale parent: this commit's parent is not the on-chain head — rebuild it onto the current head.",
			);
		}
		const txHash = await this.registry.update(repo, head, rootHexFromCid(commitCid));
		return { txHash, onChainTip: commitCid };
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
			throw new Error(`record ${link.toString()} has id ${r.id}, filed under ${id}`);
		}
		return { id, cid: link.toString(), type: r.type, payload: r.payload };
	}

	/**
	 * Net change to a single repo between two on-chain roots — the core of
	 * the subscription light-client. A plain comparison of the two id → CID
	 * maps; only records that actually changed are decoded.
	 *
	 * Diffing root-to-root (rather than walking commits) is deliberately robust:
	 * it yields the correct net delta even across a force-push / non-fast-forward
	 * reorg — exactly what an index builder needs (what to (re)embed, what to evict).
	 * Reads only the nodes on changed paths (`diffMst`): 10 new records in a
	 * 50k-record repo cost ~10 × depth nodes, not two 50k-key walks.
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

		const root = async (c: CID | null) => (c ? (await this.getCommit(c)).root : null);
		const diff = await diffMst(
			await root(oldCommit),
			await root(newCommit),
			(cid) => this.getBlock(cid, oldCommit),
			(cid) => this.getBlock(cid, newCommit),
		);
		const puts: StoredRecord[] = [];
		if (newCommit) for (const [id, cid] of diff.puts) puts.push(await this.decodeRecord(id, cid, newCommit));
		return { puts, deletes: diff.deletes, superseded: [...diff.before.values()].map(String) };
	}

	/** Diff a commit against its parent. */
	async diffCommit(commitCid: CID): Promise<CommitDiff> {
		const commit = await this.getCommit(commitCid);
		const ns = commit.repo;
		const child = (await this.stateAt(commitCid)).state;
		const par = commit.parent ? (await this.stateAt(commit.parent)).state : new Map<string, CID>();

		const added: string[] = [];
		const updated: string[] = [];
		const removed: string[] = [];
		for (const [id, cid] of child) {
			const prev = par.get(id);
			if (!prev) added.push(`${ns}/${id}`);
			else if (prev.toString() !== cid.toString()) updated.push(`${ns}/${id}`);
		}
		for (const id of par.keys()) if (!child.has(id)) removed.push(`${ns}/${id}`);

		return {
			message: commit.message,
			parent: commit.parent?.toString() ?? null,
			epoch: commit.epoch,
			repo: ns,
			root: commit.root.toString(),
			added: added.sort(),
			updated: updated.sort(),
			removed: removed.sort(),
		};
	}

	/** check if the repo already exists (head resolves) */
	async repoExists(
		publisher: Address,
		repo: RepoName,
	): Promise<boolean> {
		return (await this.resolveHeadCommit(publisher, repo)) !== null;
	}

	/** Lists every record currently committed under a repo, resolved from the on-chain root. */
	async listRepo(
		publisher: Address,
		repo: RepoName,
	): Promise<RepoContents> {
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
