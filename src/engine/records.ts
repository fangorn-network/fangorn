import { sha256 as sha256Sync } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
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
//   commit   { epoch, parent, diff, root, repo, car }
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

/**
 * Whether a block is a record, read from its first bytes without decoding it. Canonical dag-cbor sorts
 * map keys shortest first, so a record (`{ id, type, payload }`) is a map whose first key is `id`
 * (`62 69 64`). MST nodes start with `left`, commits with `car`, stitch entries with `pos`. A wrong
 * answer costs only memory or a refetch, never a wrong read: see the engine's `leanCars`.
 */
export function isRecordBlock(bytes: Uint8Array): boolean {
	return (
		bytes.length > 3 &&
		bytes[0] >= 0xa0 && // a map of at most 23 entries
		bytes[0] <= 0xb7 &&
		bytes[1] === 0x62 && // a 2-byte text key…
		bytes[2] === 0x69 && // "i"
		bytes[3] === 0x64 // "d"
	);
}

/** Whether `bytes` hash to `cid`. */
export function blockMatches(cid: CID, bytes: Uint8Array): boolean {
	return bytesToHex(cid.multihash.digest) === bytesToHex(sha256Sync(bytes));
}

/** Throw unless `bytes` hash to `cid`. Hosts are untrusted; every fetched block goes through this. */
export function assertBlockMatches(cid: CID, bytes: Uint8Array): void {
	if (!blockMatches(cid, bytes)) {
		throw new Error(`block ${cid.toString()} does not match its content hash`);
	}
}

/**
 * Throw on a value dag-cbor would store as something else: a string (or map key) with a lone
 * UTF-16 surrogate, which encodes as U+FFFD, and an own `__proto__` key, which decodes as
 * the object's prototype instead of a field. Either would change a record between put and read.
 */
export function assertStorable(value: unknown, path = "payload"): void {
	if (typeof value === "string") {
		if (!value.isWellFormed())
			throw new Error(`${path} is not a well-formed (UTF-16) string`);
	} else if (Array.isArray(value)) {
		value.forEach((v, i) => {
			assertStorable(v, `${path}[${i.toString()}]`);
		});
	} else if (
		value &&
		typeof value === "object" &&
		!(value instanceof Uint8Array) &&
		!CID.asCID(value)
	) {
		for (const [k, v] of Object.entries(value)) {
			if (k === "__proto__") throw new Error(`${path} has a __proto__ key`);
			assertStorable(k, `${path} key`);
			assertStorable(v, `${path}.${k}`);
		}
	}
}

/** Record block: one version of an entity. `id` is repeated so a record can't be filed under another key. */
export interface RecordBlock {
	id: string;
	type: string;
	payload: Record<string, unknown>;
}

/**
 * A stitch (WHITEPAPER_1 §4): the event `head` at position `pos` of repo
 * (publisher, repo). With `key`, it names the record at that key in the event's
 * state; without, the event itself (its diff). Checked by `checkStitch`.
 */
export interface Stitch {
	publisher: `0x${string}`;
	repo: string;
	pos: number;
	head: `0x${string}`;
	key?: string;
}

/**
 * A reference from one record to another, stored as a plain payload value.
 * `local`: a record id in the same repo state, follows updates. `pinned`: one
 * exact record version, by CID. `stitch`: an event or record of any repo, at a
 * position the registry's log can check.
 */
export type Ref = { local: string } | { pinned: string } | { stitch: Stitch };

/**
 * Commit block: the event (e, parent, diff, root) of WHITEPAPER_1 §2, whose
 * name is the on-chain head. `root` is the repo's MST root. `diff` is an MST
 * of what changed against the parent: id → new record CID, or null for a delete.
 *
 * Two more fields:
 *   • `repo`: the repo's name, which events carry only as keccak256(name);
 *   • `car`: the CID of the CAR file holding every block this commit
 *     introduced. The commit block itself is stored OUTSIDE that CAR
 *     (individually addressable), so a reader goes digest → commit → CAR with
 *     no index lookups.
 */
export interface CommitBlock {
	epoch: number;
	parent: CID | null;
	diff: CID;
	root: CID;
	repo: string;
	car: CID;
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
	if (!isValidRecordId(id)) {
		throw new Error(
			`invalid record id ${JSON.stringify(id)}: must be 1-${MAX_RECORD_ID_LENGTH.toString()} printable ASCII characters, no spaces`,
		);
	}
}

function isValidRecordId(id: unknown): id is string {
	return (
		typeof id === "string" &&
		id.length > 0 &&
		id.length <= MAX_RECORD_ID_LENGTH &&
		/^[\x21-\x7e]+$/.test(id)
	);
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
	/** A record CID; null only in a diff tree, where it means "deleted". */
	value: CID | null;
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
	const digest = sha256Sync(utf8ToBytes(key));
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
	state: Map<string, CID | null>,
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
		const empty = await encodeBlock({
			level: 0,
			left: null,
			entries: [],
		} satisfies MstNode);
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

export async function readMst<V extends CID | null = CID>(
	root: CID,
	getBlock: (cid: CID) => Promise<Uint8Array>,
): Promise<{ state: Map<string, V>; nodeCids: Set<string> }> {
	const state = new Map<string, V>();
	const nodeCids = new Set<string>();

	const walk = async (cid: CID, depth: number): Promise<void> => {
		if (depth > MAX_DEPTH)
			throw new Error(
				`MST at ${root.toString()} is deeper than ${MAX_DEPTH.toString()}`,
			);
		// a tree's keys are distinct, so no honest tree holds one node twice; a DAG that
		// repeats one would unroll exponentially
		if (nodeCids.has(cid.toString()))
			throw new Error(
				`MST at ${root.toString()} repeats node ${cid.toString()}`,
			);
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
			state.set(e.key, e.value as V);
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
 * A record tree's entries in key order, from just after `after` (from the start when it's null), as
 * `[key, value]`. For reading a big tree a range at a time: it holds only the path it is on, where
 * `readMst` holds every key and rebuilds the tree.
 *
 * Instead of that rebuild, each node it opens is checked against what `buildMst` makes. A node at level
 * L, between keys lo and hi:
 *   - its keys are valid record ids, strictly increasing, inside (lo, hi), and each is at level L;
 *   - its children are nodes at level L - 1, and a level-0 node has none;
 *   - a node with no keys has a left child (a gap with no key at L), except the empty tree's root,
 *     and the root has a key (its level is the highest key's).
 * Levels come from the keys, so these pin the one canonical tree over the keys read. A walk that
 * stops early has checked only what it read. Absence still needs the whole walk (or `readMst`).
 */
export async function* walkMst<V extends CID | null = CID>(
	root: CID,
	getBlock: (cid: CID) => Promise<Uint8Array>,
	{ after = null }: { after?: string | null } = {},
): AsyncGenerator<[string, V]> {
	const refuse = (cid: CID, why: string): never => {
		throw new Error(
			`MST at ${root.toString()} is not canonical: node ${cid.toString()} ${why}`,
		);
	};
	// `after` at or past `bound`: everything below the bound is already read
	const past = (bound: string | null) =>
		after !== null && bound !== null && after >= bound;

	async function* node(
		cid: CID,
		level: number | null,
		lo: string | null,
		hi: string | null,
		depth: number,
	): AsyncGenerator<[string, V]> {
		if (depth > MAX_DEPTH)
			refuse(cid, `is deeper than ${MAX_DEPTH.toString()}`);
		const n = decodeBlock<Partial<MstNode>>(await getBlock(cid));
		if (!Array.isArray(n.entries) || typeof n.level !== "number")
			return refuse(cid, "is not a record tree node");
		if (level !== null && n.level !== level)
			refuse(cid, `is at level ${n.level.toString()}, not ${level.toString()}`);
		const L = n.level,
			entries = n.entries,
			root = depth === 0;
		if (L === 0 && (n.left || entries.some((e) => e.right)))
			refuse(cid, "is at level 0 with children");
		if (entries.length === 0 && (root ? n.left : !n.left))
			refuse(cid, root ? "is a root without a key" : "is empty");
		let prev = lo;
		for (const e of entries) {
			if (!isValidRecordId(e.key))
				refuse(cid, `holds ${JSON.stringify(e.key)}, not a record id`);
			if ((prev !== null && e.key <= prev) || (hi !== null && e.key >= hi))
				refuse(cid, `holds key ${e.key} out of order`);
			if (keyLevel(e.key) !== L)
				refuse(cid, `holds key ${e.key} at level ${L.toString()}`);
			prev = e.key;
		}
		const first = entries[0]?.key ?? hi;
		if (n.left && !past(first))
			yield* node(n.left, L - 1, lo, first, depth + 1);
		for (const [i, e] of entries.entries()) {
			const next = entries[i + 1]?.key ?? hi;
			if (after === null || e.key > after) yield [e.key, e.value as V];
			if (e.right && !past(next))
				yield* node(e.right, L - 1, e.key, next, depth + 1);
		}
	}
	yield* node(root, null, null, null, 0);
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
): Promise<{
	puts: Map<string, CID>;
	deletes: string[];
	before: Map<string, CID>;
}> {
	// state trees only: values are never null here
	type Item = { sub: CID; level: number } | { key: string; value: CID };
	// Stacks, head last. A root's level is unknown until read: Infinity opens both roots first.
	const a: Item[] = oldRoot ? [{ sub: oldRoot, level: Infinity }] : [];
	const b: Item[] = newRoot ? [{ sub: newRoot, level: Infinity }] : [];
	// each side opens a node once (see readMst's repeat check)
	const opened = new Set<string>();
	const open = async (s: Item[], get: (cid: CID) => Promise<Uint8Array>) => {
		const { sub } = s.pop() as { sub: CID };
		const seen = `${s === a ? "a" : "b"}${sub.toString()}`;
		if (opened.has(seen)) throw new Error(`MST repeats node ${sub.toString()}`);
		opened.add(seen);
		const node = decodeBlock<MstNode>(await get(sub));
		const items: Item[] = node.left
			? [{ sub: node.left, level: node.level - 1 }]
			: [];
		for (const e of node.entries) {
			if (!e.value)
				throw new Error(`state tree ${sub.toString()} holds a null`);
			items.push({ key: e.key, value: e.value });
			if (e.right) items.push({ sub: e.right, level: node.level - 1 });
		}
		s.push(...items.reverse());
	};
	const puts = new Map<string, CID>(),
		before = new Map<string, CID>(),
		deletes: string[] = [];
	for (let steps = 0; a.length || b.length; steps++) {
		if (steps > 1e8) throw new Error("MST diff did not terminate");
		const x = a.at(-1),
			y = b.at(-1);
		if (x && y && "sub" in x && "sub" in y) {
			if (x.sub.equals(y.sub)) {
				a.pop();
				b.pop();
			} else if (x.level > y.level) await open(a, getOld);
			else if (y.level > x.level) await open(b, getNew);
			else {
				await open(a, getOld);
				await open(b, getNew);
			}
		} else if (x && "sub" in x) await open(a, getOld);
		else if (y && "sub" in y) await open(b, getNew);
		else if (x && (!y || x.key < y.key)) {
			a.pop();
			deletes.push(x.key);
			before.set(x.key, x.value);
		} else if (y && (!x || y.key < x.key)) {
			b.pop();
			puts.set(y.key, y.value);
		} else if (x && y) {
			a.pop();
			b.pop();
			if (!x.value.equals(y.value)) {
				puts.set(y.key, y.value);
				before.set(x.key, x.value);
			}
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
