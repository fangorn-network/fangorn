import { type Address, type Hex } from "viem";
import { MetadataStorage } from "../providers/storage/types.js";
import { canonicalize } from "./canonical.js";
import { Commit, COMMIT_KIND, EmbedContract, isCommit } from "./types.js";
import type {
    Manifest,
    BundleManifest,
    ViewManifest,
    LinksetManifest,
} from "../roles/publisher/types.js";

/** Any manifest kind doubles as a tree object in v1 (see objects/types.ts). */
export type AnyManifest = Manifest | BundleManifest | ViewManifest | LinksetManifest;

/**
 * One blob leaf: its stable content identity and its retrieval URI.
 *
 *   contentId — sha256 of the serialized chunk bytes. STABLE across commits and
 *               CARs, so byte-identical chunks share it. This is what we diff and
 *               dedup on. (Falls back to the uri for pre-contentId manifests.)
 *   uri       — the `ipfs://<carRoot>/<entry>` path used to actually fetch it.
 *               NOT stable across commits, so it must never be the diff key.
 */
export interface BlobRef {
    contentId: string;
    uri: string;
}

/** Pull every blob leaf (identity + retrieval uri) from a manifest, any kind. */
export function blobRefs(manifest: AnyManifest): BlobRef[] {
    const ref = (uri: string, contentId: unknown): BlobRef => ({
        uri,
        // pre-contentId manifests diff coarsely on the uri (their old behavior)
        contentId: typeof contentId === "string" ? contentId : uri,
    });
    switch (manifest.kind) {
        case "record-set":
            return manifest.entries
                .filter(e => typeof e.fields.dataCid === "string")
                .map(e => ref(e.fields.dataCid as string, e.fields.contentId));
        case "bundle":
            return [
                ...manifest.nodeChunks.map(c => ref(c.dataCid, c.contentId)),
                ...manifest.edgeChunks.map(c => ref(c.dataCid, c.contentId)),
            ];
        case "view":
            return [ref(manifest.viewChunk.dataCid, manifest.viewChunk.contentId)];
        case "linkset":
            return manifest.linkChunks.map(c => ref(c.dataCid, c.contentId));
    }
}

/**
 * The stable blob identities a manifest references — the diff/dedup keys. Two
 * manifests sharing an identity share that chunk (structural sharing); comparing
 * the two identity sets is the whole basis of incremental builds and deletes.
 */
export function blobCids(manifest: AnyManifest): string[] {
    return blobRefs(manifest).map(b => b.contentId);
}

export interface TreeDiff {
    /** Blob CIDs present in the child but not the parent — the new data to index. */
    added: string[];
    /** Blob CIDs present in the parent but not the child — deleted data to drop. */
    removed: string[];
}

/**
 * Structural diff between two tree snapshots. Because blobs are content-addressed,
 * an unchanged page keeps its CID and appears in neither list — so a commit that
 * touches k of n pages diffs to O(k), not O(n). `parent` undefined ⇒ root commit
 * (everything is added).
 */
export function diffManifests(parent: AnyManifest | undefined, child: AnyManifest): TreeDiff {
    const childCids = new Set(blobCids(child));
    const parentCids = new Set(parent ? blobCids(parent) : []);
    return {
        added: [...childCids].filter(c => !parentCids.has(c)),
        removed: [...parentCids].filter(c => !childCids.has(c)),
    };
}

export interface BuildCommitInput {
    parents: string[];
    /** CID of the tree/manifest object this commit snapshots. */
    tree: string;
    /** Poseidon2 root of the tree. */
    root: Hex;
    schemaId: Hex;
    author: Address;
    message: string;
    /** Defaults to Date.now(); accept an override for reproducible fixtures/tests. */
    timestamp?: number;
    embed?: EmbedContract;
}

/**
 * ObjectStore — the git-object layer over the content-addressed backend.
 *
 * It doesn't own a new store; it borrows the existing `MetadataStorage` (IPFS via
 * Pinata). Commits are written with canonical bytes so their CID is a pure
 * function of their contents, matching quickbeam's Python encoder.
 */
export class ObjectStore {
    constructor(private readonly storage: MetadataStorage) {}

    /** Build a commit object and pin it; returns the commit CID. */
    async putCommit(input: BuildCommitInput): Promise<{ cid: string; commit: Commit }> {
        const commit: Commit = {
            kind: COMMIT_KIND,
            parents: input.parents,
            tree: input.tree,
            root: input.root,
            schemaId: input.schemaId,
            author: input.author,
            message: input.message,
            timestamp: input.timestamp ?? Date.now(),
            ...(input.embed ? { embed: input.embed } : {}),
        };
        // Canonical string passes straight through the storage serializer, so the
        // bytes IPFS hashes are exactly these — deterministic CID.
        const cid = await this.storage.put(canonicalize(commit), {
            name: `commit:${commit.schemaId}:${commit.timestamp.toString()}`,
        });
        return { cid, commit };
    }

    /** Fetch and validate a commit by CID. */
    async getCommit(cid: string): Promise<Commit> {
        const obj = await this.storage.get<unknown>(cid);
        if (!isCommit(obj)) throw new Error(`object ${cid} is not a commit`);
        return obj;
    }

    /** Fetch the tree/manifest a commit points at. */
    async getTree(commit: Commit): Promise<AnyManifest> {
        return this.storage.get<AnyManifest>(commit.tree);
    }

    /**
     * Walk the first-parent chain from `tip` toward the root, newest first.
     * `limit` caps how many commits are yielded (undefined = full history).
     * Follows `parents[0]` only — the mainline — so a merge commit's other
     * parents aren't traversed here (that's a separate graph walk).
     */
    async *walkParents(tip: string, limit?: number): AsyncIterable<{ cid: string; commit: Commit }> {
        let cursor: string | undefined = tip;
        for (let count = 0; cursor !== undefined && (limit === undefined || count < limit); count++) {
            const commit = await this.getCommit(cursor);
            yield { cid: cursor, commit };
            cursor = commit.parents.length > 0 ? commit.parents[0] : undefined;
        }
    }

    /**
     * Diff a commit against its first parent: the blobs it added and removed.
     * A root commit (no parent) reports every blob as added.
     */
    async diffCommit(cid: string): Promise<TreeDiff> {
        const commit = await this.getCommit(cid);
        const childTree = await this.getTree(commit);
        const parentCid = commit.parents[0];
        const parentTree = parentCid
            ? await this.getTree(await this.getCommit(parentCid))
            : undefined;
        return diffManifests(parentTree, childTree);
    }
}
