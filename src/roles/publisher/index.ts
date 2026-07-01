import { createHash } from "crypto";
import { type Address, type Hash, type Hex, type WalletClient } from "viem";
import { LinkRecord, ResolvedBundle, ResolvedLinkset, ResolvedView, SchemaDefinition, TypeDefinition } from "../schema/types";
import { DataSourceRegistry, MerkleTree } from "../../registries/datasource-registry";
import { ObjectStore, blobRefs } from "../../objects/store";
import { EmbedContract } from "../../objects/types";
import { MetadataStorage } from "../../providers/storage/types";
import { serialize } from "../../providers/storage/utils";
import { SchemaRegistry } from "../../registries/schema-registry";
import {
    FieldInput,
    Manifest,
    PublishRecord,
    ManifestEntry,
    BundleManifest,
    BundleNode,
    HydratedBundle,
    BundleEdge,
    ViewManifest,
    LinksetManifest
} from "./types";
import { ManifestBuilder, BuildContext, ResolvedSchemaShape, ChunkRef } from "./builders/types";
import { RecordSetBuilder, RecordSetInput } from "./builders/record-set";
import { BundleBuilder, BundleUploadInput } from "./builders/bundle";
import { ViewBuilder, ViewUploadInput } from "./builders/view";
import { LinksetBuilder, LinksetUploadInput } from "./builders/linkset";

export { RecordSetBuilder } from "./builders/record-set";
export { BundleBuilder } from "./builders/bundle";
export { ViewBuilder } from "./builders/view";
export { LinksetBuilder } from "./builders/linkset";
export type { ManifestBuilder, BuildContext, ChunkDraft, ChunkRef, BaseManifest, ResolvedSchemaShape } from "./builders/types";
export type { RecordSetInput } from "./builders/record-set";
export type { BundleUploadInput } from "./builders/bundle";
export type { ViewUploadInput } from "./builders/view";
export type { LinksetUploadInput } from "./builders/linkset";

// CAR grouping bounds: how many chunks (and how many bytes) we pack into one
// CAR / one Pinata pin. A flat UnixFS directory of this many entries stays well
// under the 1 MiB block limit, and the byte cap keeps peak memory predictable.
//
// Peak CAR-layer memory ≈ concurrency × ~3 × CAR_GROUP_BYTES (serialized group +
// encoded blocks + concatenated CAR bytes), and in sharded mode this lands ON TOP
// of the whole shard already buffered in RAM. So keep the byte cap modest — even
// at 16 MB / 256 files this is still a ~256× request reduction over per-chunk PUTs.
// Raise it on a roomy box; lower it (or drop concurrency) if you OOM.
const CAR_GROUP_FILES = Math.max(1, Number(process.env.FANGORN_CAR_GROUP_FILES ?? 256));
const CAR_GROUP_BYTES = Math.max(1, Number(process.env.FANGORN_CAR_GROUP_BYTES ?? 16 * 1024 * 1024));

export interface CommitResult {
    manifestUri: string;
    schemaId: Hex;
    owner: Address;
    entryCount: number;
}

/** Result of building a commit locally (before push). */
export interface RepoCommitResult {
    commitCid: string;
    manifestCid: string;
    root: Hex;
    schemaId: Hex;
    owner: Address;
    datasetName: string;
    entryCount: number;
    /** Chunks reused byte-for-byte from the parent (not re-uploaded). */
    reusedCount: number;
    /** Chunks actually uploaded this commit. */
    uploadedCount: number;
    parents: string[];
}

export class PublisherRole {
    private readonly schemaCache = new Map<
        string,
        Promise<{ schema: ResolvedSchemaShape; schemaId: Hex }>
    >();

    constructor(
        private readonly dataSourceRegistry: DataSourceRegistry,
        private readonly schemaRegistry: SchemaRegistry,
        private readonly storage: MetadataStorage,
        private readonly walletClient: WalletClient,
    ) {}

    async publish<TIn, TMan extends { kind: string; schemaId: Hex; root: Hex; tree: Hex[][] }>(params: {
        schemaName: string;
        builder: ManifestBuilder<TIn, TMan>;
        input: TIn;
        datasetName?: string;
        concurrency?: number;
    }): Promise<CommitResult> {
        const built = await this.buildManifest(params);
        await this.dataSourceRegistry.publish(built.manifestCid, built.root, built.schemaId, built.datasetName);
        return { manifestUri: built.manifestCid, schemaId: built.schemaId, owner: built.owner, entryCount: built.entryCount };
    }

    /**
     * Build a commit: run the same chunk→assemble pipeline as `publish`, then wrap
     * the resulting manifest (the *tree*) in a Commit object parented on the local
     * tip. This is the permissionless half of the git-native flow — it pins objects
     * to IPFS and returns the new commit CID, but does NOT touch the chain. The
     * caller (CLI) moves local HEAD; `push` later registers it. See PROTOCOL.md §7.
     */
    async commit<TIn, TMan extends { kind: string; schemaId: Hex; root: Hex; tree: Hex[][] }>(params: {
        schemaName: string;
        builder: ManifestBuilder<TIn, TMan>;
        input: TIn;
        datasetName?: string;
        concurrency?: number;
        /** Parent commit CIDs — the local HEAD, or [] for the first commit. */
        parents: string[];
        message: string;
        embed?: EmbedContract;
        /** Override author timestamp (reproducible fixtures/tests). */
        timestamp?: number;
    }): Promise<RepoCommitResult> {
        const objects = new ObjectStore(this.storage);

        // Structural sharing: index the first parent's tree by contentId so
        // buildManifest can reuse (and skip re-uploading) unchanged chunks.
        let parentBlobs: Map<string, string> | undefined;
        const parentCid = params.parents[0];
        if (parentCid) {
            const parentTree = await objects.getTree(await objects.getCommit(parentCid));
            parentBlobs = new Map(blobRefs(parentTree).map(b => [b.contentId, b.uri]));
        }

        const built = await this.buildManifest({ ...params, parentBlobs });
        const { cid: commitCid } = await objects.putCommit({
            parents: params.parents,
            tree: built.manifestCid,
            root: built.root,
            schemaId: built.schemaId,
            author: built.owner,
            message: params.message,
            timestamp: params.timestamp,
            embed: params.embed,
        });
        return {
            commitCid,
            manifestCid: built.manifestCid,
            root: built.root,
            schemaId: built.schemaId,
            owner: built.owner,
            datasetName: built.datasetName,
            entryCount: built.entryCount,
            reusedCount: built.reusedCount,
            uploadedCount: built.uploadedCount,
            parents: params.parents,
        };
    }

    /**
     * Push a built commit on-chain: move the dataset's ref to `commitCid`. In v1
     * the commit CID rides in the existing `manifest_cid` slot (the "defer the
     * redeploy" trick — parent links live inside the commit object in IPFS).
     *
     * Client-side fast-forward guard: if the on-chain tip isn't the commit's
     * declared parent, someone pushed while you were working. Real CAS enforcement
     * lands in the contract at slice 3; here we refuse to clobber unless `force`.
     */
    async push(params: {
        commitCid: string;
        root: Hex;
        schemaId: Hex;
        datasetName: string;
        expectedParent?: string;
        force?: boolean;
    }): Promise<{ txHash: Hash; onChainTip: string }> {
        const owner = this.requireAccount();
        if (!params.force) {
            let currentTip: string | undefined;
            try {
                currentTip = (await this.dataSourceRegistry.get(owner, params.schemaId, params.datasetName)).manifestCid || undefined;
            } catch { currentTip = undefined; }
            const expected = params.expectedParent ?? undefined;
            if ((currentTip ?? undefined) !== expected) {
                throw new Error(
                    `non-fast-forward: on-chain tip is ${currentTip ?? "(none)"} but this commit builds on ${expected ?? "(none)"}. ` +
                    `Pull/rebuild on the current tip, or push with --force.`,
                );
            }
        }
        const txHash = await this.dataSourceRegistry.publish(params.commitCid, params.root, params.schemaId, params.datasetName);
        return { txHash, onChainTip: params.commitCid };
    }

    /**
     * Read the dataset's current on-chain tip commit CID (undefined if the repo
     * has never been pushed). This is the single trusted pointer; the entire
     * history hangs off it in IPFS and is walked with `ObjectStore.walkParents` —
     * no subgraph required. It's the starting point for `clone`.
     */
    async resolveTip(owner: Address, schemaId: Hex, datasetName: string): Promise<string | undefined> {
        try {
            const ds = await this.dataSourceRegistry.get(owner, schemaId, datasetName);
            return ds.manifestCid || undefined;
        } catch {
            return undefined;
        }
    }

    /**
     * The shared build pipeline behind both `publish` and `commit`: resolve the
     * schema, chunk + upload the input (CAR-batched), build the Merkle tree, and
     * pin the assembled manifest. Returns the manifest CID and root — the "tree" —
     * without any on-chain side effect.
     */
    private async buildManifest<TIn, TMan extends { kind: string; schemaId: Hex; root: Hex; tree: Hex[][] }>(params: {
        schemaName: string;
        builder: ManifestBuilder<TIn, TMan>;
        input: TIn;
        datasetName?: string;
        concurrency?: number;
        /**
         * Structural sharing: contentId → retrieval URI from the parent commit's
         * tree. A chunk whose serialized bytes hash to a contentId already in this
         * map is byte-identical to one the parent already stored, so we reuse the
         * parent's URI and DON'T re-upload it. Absent ⇒ every chunk is uploaded.
         */
        parentBlobs?: Map<string, string>;
    }): Promise<{ manifestCid: string; root: Hex; schemaId: Hex; owner: Address; datasetName: string; entryCount: number; reusedCount: number; uploadedCount: number }> {
        const { schemaName, builder, input, datasetName, concurrency = 10, parentBlobs } = params;
        const { schema, schemaId } = await this.resolveSchema(schemaName);

        await builder.validate(schema, input);

        // Commit context known before chunking: the datasource resourceId that
        // Phase-0 Entity URIs are prefixed with. Derived from the same
        // (owner, schemaId, datasetName) used to publish the datasource below.
        const owner = this.requireAccount();
        const ds = datasetName ?? `${schemaId}:${owner}`;
        const resourceId = DataSourceRegistry.resourceId(owner, schemaId, ds);

        // CAR-batched upload: instead of one HTTP POST per chunk, we pack many
        // chunks into a single locally-built CAR (one pin = one request) and run
        // up to `concurrency` such CAR uploads in flight. Chunks are pre-serialized
        // once here (the string passes straight through the storage layer), so we
        // know each group's exact byte size and bound it two ways — peak memory
        // stays ~`concurrency` × CAR_GROUP_BYTES regardless of dataset size.
        const chunks: ChunkRef[] = [];
        const inFlight = new Set<Promise<unknown>>();
        let firstErr: unknown;
        let idx = 0n;
        let reusedCount = 0;

        let group: { index: bigint; name: string; data: string; contentId: string; meta: ChunkRef["meta"] }[] = [];
        let groupBytes = 0;
        const flushGroup = (): void => {
            if (group.length === 0) return;
            const g = group;
            group = [];
            groupBytes = 0;
            const task = (async () => {
                const cidByName = await this.storage.putMany(g.map(c => ({ data: c.data, name: c.name })));
                for (const c of g) {
                    const cid = cidByName[c.name];
                    if (!cid) throw new Error(`CAR upload returned no CID for chunk "${c.name}"`);
                    chunks.push({ index: c.index, cid, contentId: c.contentId, name: c.name, meta: c.meta });
                }
            })().catch((e: unknown) => { firstErr ??= e; });
            inFlight.add(task);
            void task.finally(() => inFlight.delete(task));
        };

        for await (const draft of builder.chunk(input, schema, { resourceId })) {
            if (firstErr) break;
            const myIdx = idx++; // assigned in generation order — preserves leaf indexing
            const data = serialize(draft.data);
            const contentId = createHash("sha256").update(data).digest("hex");

            // Structural sharing: if the parent commit already stored a byte-identical
            // chunk, reuse its URI and skip the upload entirely — only changed chunks
            // hit the network (PROTOCOL.md §4).
            const reusedUri = parentBlobs?.get(contentId);
            if (reusedUri !== undefined) {
                chunks.push({ index: myIdx, cid: reusedUri, contentId, name: draft.name, meta: draft.meta });
                reusedCount++;
                continue;
            }

            group.push({ index: myIdx, name: draft.name, data, contentId, meta: draft.meta });
            groupBytes += data.length;
            if (group.length >= CAR_GROUP_FILES || groupBytes >= CAR_GROUP_BYTES) flushGroup();
            // `while`, not `if`: the settled task's `.finally` delete may not have
            // run yet when Promise.race resolves, so keep draining until under cap.
            while (inFlight.size >= concurrency) await Promise.race(inFlight);
        }
        if (!firstErr) flushGroup();

        await Promise.all(inFlight);
        // Rethrow the first upload rejection verbatim (matches prior Promise.all behavior).
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        if (firstErr !== undefined) throw firstErr;
        if (chunks.length === 0) throw new Error("builder produced no chunks");

        chunks.sort((a, b) => builder.compareChunks(a, b));

        const leafInputs = chunks.map(c => ({ index: c.index, name: c.cid }));
        const leaves: Hex[] = leafInputs.map(l => MerkleTree.rootToHex(MerkleTree.leafHash(l)));
        const { root, layers } = MerkleTree.buildTree(leafInputs);

        const context: BuildContext = {
            schemaId,
            chunks,
            leaves,
            root: MerkleTree.rootToHex(root),
            layers: layers.map(layer => layer.map(r => MerkleTree.rootToHex(r))),
        };

        const manifest = builder.assemble(context, input, schema);
        const manifestCid = await this.storage.put(manifest, {
            name: `manifest:${builder.kind}:${schemaId}:${Date.now().toString()}`,
        });

        return {
            manifestCid, root: context.root, schemaId, owner, datasetName: ds,
            entryCount: chunks.length, reusedCount, uploadedCount: chunks.length - reusedCount,
        };
    }

    async publishRecords(params: {
        records: PublishRecord[] | AsyncIterable<PublishRecord>;
        schemaName: string;
        chunkSize?: number;
        concurrency?: number;
        datasetName?: string;
    }): Promise<CommitResult> { 
        return this.publish({
            schemaName: params.schemaName,
            builder: new RecordSetBuilder(),
            input: { records: params.records, chunkSize: params.chunkSize } satisfies RecordSetInput,
            datasetName: params.datasetName,
            concurrency: params.concurrency,
        });
    }

    /** Commit a record-set locally (build + wrap, no on-chain push). */
    async commitRecords(params: {
        records: PublishRecord[] | AsyncIterable<PublishRecord>;
        schemaName: string;
        parents: string[];
        message: string;
        chunkSize?: number;
        concurrency?: number;
        datasetName?: string;
        embed?: EmbedContract;
        timestamp?: number;
    }): Promise<RepoCommitResult> {
        return this.commit({
            schemaName: params.schemaName,
            builder: new RecordSetBuilder(),
            input: { records: params.records, chunkSize: params.chunkSize } satisfies RecordSetInput,
            datasetName: params.datasetName,
            concurrency: params.concurrency,
            parents: params.parents,
            message: params.message,
            embed: params.embed,
            timestamp: params.timestamp,
        });
    }

    async publishBundle(params: {
        bundleName: string;
        nodes: { 
            id: string; 
            type: string; 
            fields: Record<string, FieldInput> }[] | AsyncIterable<{ id: string; type: string; fields: Record<string, FieldInput> }>;
        edges?: { 
            rel: string; 
            from: string; to: string }[] | AsyncIterable<{ rel: string; from: string; to: string }>;
        datasetName?: string;
        concurrency?: number;
        /** Entries per merkle leaf (default 1000). */
        chunkSize?: number;
        /** Cross-node graph validation; set false for huge streamed inputs (see BundleUploadInput). */
        validate?: boolean;
    }): Promise<CommitResult> {
        return this.publish({
            schemaName: params.bundleName,
            builder: new BundleBuilder(this.storage, this.schemaRegistry),
            input: {
                bundleName: params.bundleName,
                nodes: params.nodes,
                edges: params.edges,
                chunkSize: params.chunkSize,
                validate: params.validate,
            } satisfies BundleUploadInput,
            datasetName: params.datasetName,
            concurrency: params.concurrency,
        });
    }

    /**
     * Publish a composed view as a datasource. The view must already be
     * registered (kind:"view") — its resolved declaration (sources/linksets/
     * trust) is read back via resolveSchema and committed as a single-leaf
     * manifest. See docs/CROSS_PUBLISHER_LINKING_PLAN.md §4.
     */
    async publishView(params: {
        viewName: string;
        datasetName?: string;
    }): Promise<CommitResult> {
        return this.publish({
            schemaName: params.viewName,
            builder: new ViewBuilder(),
            input: { viewName: params.viewName } satisfies ViewUploadInput,
            datasetName: params.datasetName,
        });
    }

    /**
     * Publish a linkset (asserted cross-edges) as a datasource. The linkset must
     * already be registered (kind:"linkset"). Each link is validated (well-formed
     * global endpoints, allowed relation, sane confidence) before commit. See
     * docs/CROSS_PUBLISHER_LINKING_PLAN.md §5.
     */
    async publishLinkset(params: {
        linksetName: string;
        links: LinkRecord[] | AsyncIterable<LinkRecord>;
        datasetName?: string;
        chunkSize?: number;
        concurrency?: number;
    }): Promise<CommitResult> {
        return this.publish({
            schemaName: params.linksetName,
            builder: new LinksetBuilder(),
            input: { linksetName: params.linksetName, links: params.links, chunkSize: params.chunkSize } satisfies LinksetUploadInput,
            datasetName: params.datasetName,
            concurrency: params.concurrency,
        });
    }

    async getLinksetManifestByCid(manifestCid: string): Promise<LinksetManifest | undefined> {
        try {
            const manifest = await this.storage.get<LinksetManifest>(manifestCid);
            if ((manifest as { kind?: unknown }).kind !== "linkset") return undefined;
            return manifest;
        } catch { return undefined; }
    }

    async getLinksetManifest(linksetName: string, datasetName: string): Promise<LinksetManifest | undefined> {
        const linksetSchemaId = await this.schemaRegistry.schemaId(linksetName);
        const owner = this.requireAccount();
        try {
            const ds = await this.dataSourceRegistry.get(owner, linksetSchemaId, datasetName);
            if (!ds.manifestCid) return undefined;
            return await this.getLinksetManifestByCid(ds.manifestCid);
        } catch { return undefined; }
    }

    async getViewManifestByCid(manifestCid: string): Promise<ViewManifest | undefined> {
        try {
            const manifest = await this.storage.get<ViewManifest>(manifestCid);
            if ((manifest as { kind?: unknown }).kind !== "view") return undefined;
            return manifest;
        } catch { return undefined; }
    }

    async getViewManifest(viewName: string, datasetName: string): Promise<ViewManifest | undefined> {
        const viewSchemaId = await this.schemaRegistry.schemaId(viewName);
        const owner = this.requireAccount();
        try {
            const ds = await this.dataSourceRegistry.get(owner, viewSchemaId, datasetName);
            if (!ds.manifestCid) return undefined;
            return await this.getViewManifestByCid(ds.manifestCid);
        } catch { return undefined; }
    }

    async readBundle(manifest: BundleManifest): Promise<HydratedBundle> {
        const nodeArrays = await Promise.all(
            manifest.nodeChunks.map(chunk => this.storage.get<BundleNode[]>(chunk.dataCid)),
        );

        const edgeRefs = manifest.edgeChunks;
        const edgeArrays = await Promise.all(
            edgeRefs.map(chunk => this.storage.get<BundleEdge[]>(chunk.dataCid)),
        );
        const nodesById = new Map<string, BundleNode>();
        for (const nodes of nodeArrays) {
            for (const node of nodes) nodesById.set(node.id, node);
        }
        const edges: BundleEdge[] = [];
        for (const arr of edgeArrays) {
            for (const e of arr) edges.push(e);
        }
        return { nodesById, edges };
    }

    async getManifest(schemaName: string, datasetName: string): Promise<Manifest | undefined> {
        const schemaId = (await this.resolveSchema(schemaName)).schemaId;
        const owner = this.requireAccount();
        try {
            const ds = await this.dataSourceRegistry.get(owner, schemaId, datasetName);
            if (!ds.manifestCid) return undefined;
            return await this.storage.get<Manifest>(ds.manifestCid);
        } catch {
            return undefined;
        }
    }

    async getEntry(schemaName: string, datasetName: string, recordName: string): Promise<ManifestEntry> {
        const manifest = await this.getManifest(schemaName, datasetName);
        if (!manifest) throw new Error(`No manifest found for schema ${schemaName} under dataset ${datasetName}`);
        for (const chunkEntry of manifest.entries) {
            const dataCid = chunkEntry.fields.dataCid;
            if (typeof dataCid !== "string") continue;
            try {
                const chunkRecords = await this.storage.get<ManifestEntry[]>(dataCid);
                const found = chunkRecords.find(r => r.name === recordName);
                if (found) return found;
            } catch { continue; }
        }
        throw new Error(`Entry "${recordName}" not found in dataset ${datasetName}`);
    }

    async getBundleManifestByCid(manifestCid: string): Promise<BundleManifest | undefined> {
        try {
            const manifest = await this.storage.get<BundleManifest>(manifestCid);
            if ((manifest as { kind?: unknown }).kind !== "bundle") return undefined;
            return manifest;
        } catch { return undefined; }
    }

    async getBundleManifest(bundleName: string, datasetName: string): Promise<BundleManifest | undefined> {
        const bundleSchemaId = await this.schemaRegistry.schemaId(bundleName);
        const owner = this.requireAccount();
        try {
            const ds = await this.dataSourceRegistry.get(owner, bundleSchemaId, datasetName);
            if (!ds.manifestCid) return undefined;
            return await this.getBundleManifestByCid(ds.manifestCid);
        } catch { return undefined; }
    }

    private resolveSchema(name: string): Promise<{ schema: ResolvedSchemaShape; schemaId: Hex }> {
        const cached = this.schemaCache.get(name);
        if (cached) return cached;

        const p = Promise.all([
            this.schemaRegistry.getSchema(name),
            this.schemaRegistry.schemaId(name),
        ]).then(async ([{ specCid }, schemaId]) => {
            const blob = await this.storage.get<{ definition?: SchemaDefinition; types?: Record<string, TypeDefinition>; bundle?: ResolvedBundle; view?: ResolvedView; linkset?: ResolvedLinkset }>(specCid);
            const schema: ResolvedSchemaShape | undefined = blob.view
                ?? blob.linkset
                ?? blob.bundle
                ?? (blob.definition ? { fields: blob.definition, types: blob.types } : undefined);
            if (!schema) throw new Error(`schema "${name}" has no definition, bundle, view, nor linkset`);
            return { schema, schemaId };
        }).catch((err: unknown) => { this.schemaCache.delete(name); throw err; });
        this.schemaCache.set(name, p);
        return p;
    }

    private requireAccount(): Address {
        const address = this.walletClient.account?.address;
        if (!address) throw new Error("No account connected");
        return address;
    }
}
