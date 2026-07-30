import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as dagCbor from "@ipld/dag-cbor";

// ── Native IPLD metagraph codec ──────────────────────────────────────────────
//
// The publisher's entire state is one DAG of dag-cbor blocks:
//
//   commit ──▶ root map ──▶ namespace tree ──▶ page ──▶ vertex / edge
//
//   vertex   { schemaId, payload }                    — a graph node
//   edge     { source: Link, relation, target: Link } — native links, no keys
//   page     Link[]                                   — a sorted slice of links
//   tree     { vertices: Link<page>[], edges: Link<page>[] }
//   root map { [namespace]: Link<tree> }              — one per publisher
//   commit   { root, parents, timestamp, message, car }
//
// Everything is canonical dag-cbor over sha256, so identical logical content
// always re-derives the identical CID — that is what makes cross-commit
// structural sharing (and the CAR delta computed in the engine) correct.

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

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- caller-chosen decode type is the point
export function decodeBlock<T>(bytes: Uint8Array): T {
	return dagCbor.decode(bytes);
}

/**
 * Check that `bytes` really are the block `cid` names. Every read comes from an
 * untrusted source (a public gateway, a pinning service, whoever hosts the CAR),
 * while the only trusted input is the on-chain digest — so bytes are worth
 * exactly as much as their hash.
 */
export async function blockMatchesCid(
	cid: CID,
	bytes: Uint8Array,
): Promise<boolean> {
	if (cid.multihash.code !== sha256.code) return false;
	const digest = (await sha256.digest(bytes)).digest;
	const expected = cid.multihash.digest;
	if (digest.length !== expected.length) return false;
	let diff = 0;
	for (let i = 0; i < digest.length; i++) diff |= digest[i] ^ expected[i];
	return diff === 0;
}

/** {@link blockMatchesCid}, throwing instead of returning false. */
export async function assertBlockMatchesCid(
	cid: CID,
	bytes: Uint8Array,
): Promise<void> {
	if (!(await blockMatchesCid(cid, bytes))) {
		throw new Error(
			`Block ${cid.toString()} failed content-address verification: ` +
			"the storage backend returned bytes that do not hash to the requested CID.",
		);
	}
}

/** Vertex block: a JSON payload tagged by a free-form schema id. */
export interface VertexBlock {
	schemaId: string;
	payload: Record<string, unknown>;
}

/** Edge block: a labeled relation between two vertex blocks, as native links. */
export interface EdgeBlock {
	source: CID;
	relation: string;
	target: CID;
}

/**
 * Namespace tree: the complete current contents of one namespace, as pages of
 * sorted vertex/edge links. Paged so a namespace of any size never produces a
 * single oversized block; sorted so the same set of links always builds the
 * same pages (deterministic CIDs → structural sharing across commits).
 */
export interface NamespaceTree {
	vertices: CID[]; // links to pages of vertex links
	edges: CID[]; // links to pages of edge links
}

/**
 * Average links per page. Boundaries are content-defined (a link closes its
 * page when its digest satisfies a 1-in-TARGET_PAGE_SIZE condition), so an
 * insertion into the sorted link set only rewrites the page it lands in —
 * NOT every page after it, as fixed-size chunking would. That keeps the CAR
 * delta of an incremental commit proportional to the delta, not to the
 * accumulated namespace size. Kept small (256 links ≈ 10KB) so the unit of
 * rewrite is cheap; a large staged delta touches many pages, but never costs
 * more than the namespace's total page bytes.
 */
export const TARGET_PAGE_SIZE = 256;
/** Hard cap so a pathological digest run can't produce an oversized page block. */
export const MAX_PAGE_SIZE = 4 * TARGET_PAGE_SIZE;

/** Content-defined boundary: last two digest bytes mod the target size. */
function isPageBoundary(link: CID): boolean {
	const d = link.multihash.digest;
	return ((d[d.length - 2] << 8) | d[d.length - 1]) % TARGET_PAGE_SIZE === 0;
}

/** Root map: every namespace this publisher has, each pointing at its tree. */
export type RootMap = Record<string, CID>;

/**
 * Commit block: the git-like history object the on-chain digest points at.
 * `car` is the opaque storage URI of the CAR file holding every block this
 * commit introduced — the commit block itself is stored OUTSIDE that CAR
 * (individually addressable), so a reader goes digest → commit → CAR with no
 * index lookups.
 */
export interface CommitBlock {
	root: CID;
	parents: CID[];
	timestamp: number;
	message: string;
	car: string;
}

/** Sort link strings the way pages are ordered (plain lexicographic CID text). */
function sortedUnique(links: Iterable<CID>): CID[] {
	const byStr = new Map<string, CID>();
	for (const l of links) byStr.set(l.toString(), l);
	return [...byStr.entries()]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([, c]) => c);
}

/** Build the page blocks for a set of links; returns the page links in tree order. */
export async function buildPages(
	links: Iterable<CID>,
): Promise<{ pages: Block[]; pageLinks: CID[] }> {
	const sorted = sortedUnique(links);
	const pages: Block[] = [];
	const pageLinks: CID[] = [];

	let current: CID[] = [];
	const close = async () => {
		if (current.length === 0) return;
		const page = await encodeBlock(current);
		pages.push(page);
		pageLinks.push(page.cid);
		current = [];
	};
	for (const link of sorted) {
		current.push(link);
		if (isPageBoundary(link) || current.length >= MAX_PAGE_SIZE) await close();
	}
	await close();

	return { pages, pageLinks };
}

/** Read every link out of a tree's pages via `getBlock`. */
export async function readPages(
	pageLinks: CID[],
	getBlock: (cid: CID) => Promise<Uint8Array>,
): Promise<CID[]> {
	const out: CID[] = [];
	for (const link of pageLinks) {
		out.push(...decodeBlock<CID[]>(await getBlock(link)));
	}
	return out;
}
