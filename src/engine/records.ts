import { createHash } from "crypto";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as dagCbor from "@ipld/dag-cbor";

// ── Record codec ─────────────────────────────────────────────────────────────
//
// A repo's state is a map from record id to record (FOUNDATIONS §2):
//
//   commit ──▶ MST node ──▶ … ──▶ MST node
//                                │
//                                └──▶ record { id, type, payload }
//
//   record   { id, type, payload }                     — one version of an entity
//   MST node { level, left, entries: [{ key, value, right }] }
//   commit   { epoch, parent, root, repo, message, car }
//
// Relations are not a separate block kind: a relation is a record whose payload
// holds `src`/`dst` references (`Ref`). Everything is canonical dag-cbor over
// sha256, so identical logical content always re-derives the identical CID —
// that is what makes cross-commit structural sharing correct.

/** A content-addressed IPLD block. */
export interface Block {
	cid: CID;
	bytes: Uint8Array;
}

/** Encode any value as canonical dag-cbor and derive its CIDv1 (sha256). */
export async function encodeBlock(obj: unknown): Promise<Block> {
	const bytes = dagCbor.encode(obj);
	const hash = await sha256.digest(bytes);
	return { cid: CID.createV1(dagCbor.code, hash), bytes };
}

/**
 * Decode a dag-cbor block. The decoder is strict (minimal encodings, sorted
 * map keys), so a block has one accepted byte form (FOUNDATIONS P1).
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- caller-chosen decode type is the point
export function decodeBlock<T>(bytes: Uint8Array): T {
	return dagCbor.decode(bytes);
}

/** Throw unless `bytes` hash to `cid`. Hosts are untrusted; every fetched block goes through this. */
export function assertBlockMatches(cid: CID, bytes: Uint8Array): void {
	const digest = createHash("sha256").update(bytes).digest();
	if (!Buffer.from(cid.multihash.digest).equals(digest)) {
		throw new Error(`block ${cid.toString()} does not match its content hash`);
	}
}

/** Record block: one version of an entity. `id` is repeated so a record can't be filed under another key. */
export interface RecordBlock {
	id: string;
	type: string;
	payload: Record<string, unknown>;
}

/**
 * A reference from one record to another (FOUNDATIONS §2.2), stored as a plain
 * payload value. `local`: a record id in the same repo state, follows
 * updates. `pinned`: one exact record version, by CID.
 * ponytail: no `live` (cross-repo) refs and no resolver yet — add with
 * the §10 graph extension.
 */
export type Ref = { local: string } | { pinned: string };

/**
 * Commit block: γ = (e, parent, root) of WHITEPAPER_1 §3.1, whose name is the
 * on-chain head. `root` is the repo's MST root.
 *
 * Three more fields, until the registry computes heads from (e, parent, root)
 * itself (docs/REGISTRY_SPEC.md):
 *   • `repo`: the repo's name, which events carry only as keccak256(name);
 *   • `message`: a commit note;
 *   • `car`: the opaque storage URI of the CAR file holding every block this
 *     commit introduced. The commit block itself is stored OUTSIDE that CAR
 *     (individually addressable), so a reader goes digest → commit → CAR with
 *     no index lookups.
 */
export interface CommitBlock {
	epoch: number;
	parent: CID | null;
	root: CID;
	repo: string;
	message: string;
	car: string;
}

// ── Record ids ───────────────────────────────────────────────────────────────

/** Upper bound on a record id's length. */
export const MAX_RECORD_ID_LENGTH = 256;

/**
 * Record ids are printable ASCII, so JS string order is byte order and every
 * implementation sorts MST keys the same way. Ids of sealed data should be
 * random (FOUNDATIONS P7): a guessable id lets an observer test what exists.
 */
export function assertValidRecordId(id: string): void {
	if (
		typeof id !== "string" ||
		id.length === 0 ||
		id.length > MAX_RECORD_ID_LENGTH ||
		!/^[\x21-\x7e]+$/.test(id)
	) {
		throw new Error(
			`invalid record id ${JSON.stringify(id)}: must be 1-${MAX_RECORD_ID_LENGTH.toString()} printable ASCII characters, no spaces`,
		);
	}
}

// ── Merkle Search Tree (FOUNDATIONS §2.3) ────────────────────────────────────
//
// Keyed by record id, valued by record CID. A key's level comes from its hash,
// so the tree is a function of the key set alone (any insertion order builds
// the same root), an edit rewrites one node per level, and a lookup's path is
// an inclusion or absence proof.

/** b: expected fanout 2^b = 16. */
export const MST_BITS = 4;
/** Levels come from a 256-bit hash, so no honest tree is deeper (FOUNDATIONS P22). */
const MAX_DEPTH = 256 / MST_BITS + 1;

export interface MstEntry {
	key: string;
	value: CID;
	/** Subtree of keys between this key and the next one. */
	right: CID | null;
}

export interface MstNode {
	level: number;
	/** Subtree of keys before the first entry. */
	left: CID | null;
	entries: MstEntry[];
}

/** level(k) = ⌊leading zero bits of sha256(k) / b⌋ */
export function keyLevel(key: string): number {
	const digest = createHash("sha256").update(key).digest();
	let zeros = 0;
	for (const byte of digest) {
		if (byte !== 0) {
			zeros += Math.clz32(byte) - 24;
			break;
		}
		zeros += 8;
	}
	return Math.floor(zeros / MST_BITS);
}

/**
 * Build the MST for a state. Returns the root and every node block; callers
 * diff node CIDs against the parent's to find what to upload.
 * ponytail: rebuilds the whole tree per commit (O(n) hashing, same as the
 * page model it replaced); update only the changed paths if large repos
 * make commits CPU-bound.
 */
export async function buildMst(
	state: Map<string, CID>,
): Promise<{ root: CID; nodes: Block[] }> {
	const items = [...state]
		.map(([key, value]) => ({ key, value, level: keyLevel(key) }))
		.sort((a, b) => (a.key < b.key ? -1 : 1));
	const nodes: Block[] = [];

	const build = async (
		slice: typeof items,
		level: number,
	): Promise<CID | null> => {
		if (slice.length === 0) return null;
		const node: MstNode = { level, left: null, entries: [] };
		let gap: typeof items = [];
		const closeGap = async () => {
			const child = level === 0 ? null : await build(gap, level - 1);
			const last = node.entries.at(-1);
			if (last) last.right = child;
			else node.left = child;
			gap = [];
		};
		for (const item of slice) {
			if (item.level !== level) {
				gap.push(item);
				continue;
			}
			await closeGap();
			node.entries.push({ key: item.key, value: item.value, right: null });
		}
		await closeGap();
		const block = await encodeBlock(node);
		nodes.push(block);
		return block.cid;
	};

	const top = items.reduce((max, i) => Math.max(max, i.level), 0);
	let root = await build(items, top);
	if (!root) {
		// the empty state is one empty node
		const empty = await encodeBlock({ level: 0, left: null, entries: [] } satisfies MstNode);
		nodes.push(empty);
		root = empty.cid;
	}
	return { root, nodes };
}

/**
 * Read a whole MST back into its state, rejecting any tree that isn't exactly
 * what `buildMst` makes of that state (MSTCheck, FOUNDATIONS P2): rebuilding
 * and comparing roots catches duplicate, misordered, misplaced and wrong-level
 * keys in one check.
 */
export async function readMst(
	root: CID,
	getBlock: (cid: CID) => Promise<Uint8Array>,
): Promise<{ state: Map<string, CID>; nodeCids: Set<string> }> {
	const state = new Map<string, CID>();
	const nodeCids = new Set<string>();

	const walk = async (cid: CID, depth: number): Promise<void> => {
		if (depth > MAX_DEPTH) throw new Error(`MST at ${root.toString()} is deeper than ${MAX_DEPTH.toString()}`);
		nodeCids.add(cid.toString());
		const node = decodeBlock<Partial<MstNode>>(await getBlock(cid));
		if (!Array.isArray(node.entries)) {
			throw new Error(
				`${cid.toString()} is not a record tree node — graph-era data (vertices/edges) is no longer readable. ` +
					"Reset the on-chain head (`fangorn reset`) and re-publish.",
			);
		}
		if (node.left) await walk(node.left, depth + 1);
		for (const e of node.entries) {
			state.set(e.key, e.value);
			if (e.right) await walk(e.right, depth + 1);
		}
	};
	await walk(root, 0);

	const rebuilt = await buildMst(state);
	if (rebuilt.root.toString() !== root.toString()) {
		throw new Error(`MST at ${root.toString()} is not canonical`);
	}
	return { state, nodeCids };
}

/**
 * What changed from one tree to another: `puts` (new keys, and keys with a new value) and `deletes`
 * (keys gone), each with its old value in `before`. Both trees are read as in-order streams of entries
 * and unopened subtrees; a subtree with the same CID at the head of both streams holds the same keys
 * and values, so it is dropped unread. Only nodes on changed paths are fetched: ~changes × depth,
 * not the size of either tree.
 * ponytail: unlike readMst, does not prove either tree canonical (that needs every key). Blocks are
 * still hash-checked by `getBlock`; a publisher's malformed tree can only misreport its own records.
 */
export async function diffMst(
	oldRoot: CID | null,
	newRoot: CID | null,
	getOld: (cid: CID) => Promise<Uint8Array>,
	getNew: (cid: CID) => Promise<Uint8Array>,
): Promise<{ puts: Map<string, CID>; deletes: string[]; before: Map<string, CID> }> {
	type Item = { sub: CID; level: number } | { key: string; value: CID };
	// Stacks, head last. A root's level is unknown until read: Infinity opens both roots first.
	const a: Item[] = oldRoot ? [{ sub: oldRoot, level: Infinity }] : [];
	const b: Item[] = newRoot ? [{ sub: newRoot, level: Infinity }] : [];
	const open = async (s: Item[], get: (cid: CID) => Promise<Uint8Array>) => {
		const { sub } = s.pop() as { sub: CID };
		const node = decodeBlock<MstNode>(await get(sub));
		const items: Item[] = node.left ? [{ sub: node.left, level: node.level - 1 }] : [];
		for (const e of node.entries) {
			items.push({ key: e.key, value: e.value });
			if (e.right) items.push({ sub: e.right, level: node.level - 1 });
		}
		s.push(...items.reverse());
	};
	const puts = new Map<string, CID>(), before = new Map<string, CID>(), deletes: string[] = [];
	for (let steps = 0; a.length || b.length; steps++) {
		if (steps > 1e8) throw new Error("MST diff did not terminate");
		const x = a.at(-1), y = b.at(-1);
		if (x && y && "sub" in x && "sub" in y) {
			if (x.sub.equals(y.sub)) { a.pop(); b.pop(); }
			else if (x.level > y.level) await open(a, getOld);
			else if (y.level > x.level) await open(b, getNew);
			else { await open(a, getOld); await open(b, getNew); }
		} else if (x && "sub" in x) await open(a, getOld);
		else if (y && "sub" in y) await open(b, getNew);
		else if (x && (!y || x.key < y.key)) { a.pop(); deletes.push(x.key); before.set(x.key, x.value); }
		else if (y && (!x || y.key < x.key)) { b.pop(); puts.set(y.key, y.value); }
		else if (x && y) {
			a.pop(); b.pop();
			if (!x.value.equals(y.value)) { puts.set(y.key, y.value); before.set(x.key, x.value); }
		}
	}
	return { puts, deletes, before };
}

/**
 * The record CID stored under `key`, or null if absent — one node per level.
 * ponytail: trusts node ordering on the path, so a malformed tree can hide a
 * record (never forge one: the caller checks the record's id). Run `readMst`
 * first where absence must be proven.
 */
export async function lookupMst(
	root: CID,
	key: string,
	getBlock: (cid: CID) => Promise<Uint8Array>,
): Promise<CID | null> {
	let cursor: CID | null = root;
	for (let depth = 0; cursor && depth <= MAX_DEPTH; depth++) {
		const node: MstNode = decodeBlock<MstNode>(await getBlock(cursor));
		let next = node.left;
		for (const e of node.entries) {
			if (e.key === key) return e.value;
			if (e.key > key) break;
			next = e.right;
		}
		cursor = next;
	}
	return null;
}
