import { type Address, type Hex } from "viem";

/**
 * The object model — the git-native layer.
 *
 * Fangorn data is stored as a Merkle DAG in IPFS, exactly like git stores code:
 *
 *   blob   — an immutable chunk of data (a page of records/nodes/edges), named
 *            by the hash of its bytes. These already exist: they're the chunk
 *            CIDs the builders upload.
 *   tree   — a snapshot: the set of blobs that make up the dataset at one point
 *            in time, plus one Merkle root that fingerprints the whole set. In
 *            v1 the existing *manifest* (record-set / bundle / view / linkset)
 *            IS the tree object — it already lists the blob CIDs and carries the
 *            Poseidon2 root. We don't reinvent it; we wrap it.
 *   commit — a tree plus provenance: who made it, when, what changed (its
 *            parent), and which schema it conforms to. This is the new object.
 *   ref    — the mutable on-chain pointer to the tip commit. Today that's the
 *            `manifest_cid` slot in the DataSource registry; a commit CID rides
 *            in it unchanged (the "defer the redeploy" trick, plan slice 1).
 *
 * See docs/PROTOCOL.md §3–§5 for the plain-language version.
 */

export const COMMIT_KIND = "commit" as const;

/**
 * The embedding contract a commit carries so quickbeam inherits how to index it
 * (model / dimensionality / distance) instead of hardcoding it (FRAMEWORK Gap A).
 * Optional in v1; when absent quickbeam falls back to its CLI flags.
 */
export interface EmbedContract {
    model: string;
    dim: number;
    distance: string;
}

/**
 * A commit: an immutable, content-addressed snapshot-with-history.
 *
 * `parents` is the DAG edge that turns a pile of snapshots into walkable history:
 *   - `[]`            — the root (initial) commit of a repo
 *   - `[cid]`         — an ordinary update, built on the previous tip
 *   - `[a, b, ...]`   — a merge (a view fusing several source tips; slice 4)
 *
 * `tree` is the CID of the manifest/tree object this commit snapshots. `root` is
 * that tree's Poseidon2 Merkle root, mirrored here so the on-chain root and the
 * commit can be checked against each other without fetching the tree.
 */
export interface Commit {
    kind: typeof COMMIT_KIND;
    /** Parent commit CIDs. Empty for the root commit. */
    parents: string[];
    /** CID of the tree (manifest) object this commit points at. */
    tree: string;
    /** Poseidon2 Merkle root of the tree (mirrors the on-chain root). */
    root: Hex;
    /** Schema this commit's data conforms to. */
    schemaId: Hex;
    /** Address that authored the commit. */
    author: Address;
    /** Human-readable commit message. */
    message: string;
    /** Author timestamp, unix milliseconds. */
    timestamp: number;
    /** Optional embedding contract inherited by the indexer (Gap A). */
    embed?: EmbedContract;
}

/**
 * Structural narrowing: is this parsed object a commit? Kept deliberately loose
 * (checks the discriminant + the load-bearing fields) so a future field addition
 * doesn't reject older commits when walking history.
 */
export function isCommit(value: unknown): value is Commit {
    if (value === null || typeof value !== "object") return false;
    const o = value as Record<string, unknown>;
    return (
        o.kind === COMMIT_KIND &&
        Array.isArray(o.parents) &&
        typeof o.tree === "string" &&
        typeof o.root === "string" &&
        typeof o.schemaId === "string" &&
        typeof o.author === "string" &&
        typeof o.message === "string" &&
        typeof o.timestamp === "number"
    );
}
