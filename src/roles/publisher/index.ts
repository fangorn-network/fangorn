import { type Address, type Hex, type WalletClient } from "viem";
import { ResolvedBundle, SchemaDefinition } from "../schema/types";
import { DataSourceRegistry, MerkleTree } from "../../registries/datasource-registry";
import { MetadataStorage } from "../../providers/storage/types";
import { SchemaRegistry } from "../../registries/schema-registry";
import {
    FieldInput,
    Manifest,
    PublishRecord,
    ManifestEntry,
    BundleManifest,
    BundleNode,
    HydratedBundle,
    BundleEdge
} from "./types";
import { ManifestBuilder, BuildContext, ResolvedSchemaShape, ChunkRef } from "./builders/types";
import { RecordSetBuilder, RecordSetInput } from "./builders/record-set";
import { BundleBuilder, BundleUploadInput } from "./builders/bundle";

export { RecordSetBuilder } from "./builders/record-set";
export { BundleBuilder } from "./builders/bundle";
export type { ManifestBuilder, BuildContext, ChunkDraft, ChunkRef, BaseManifest, ResolvedSchemaShape } from "./builders/types";
export type { RecordSetInput } from "./builders/record-set";
export type { BundleUploadInput } from "./builders/bundle";

export interface CommitResult {
    manifestUri: string;
    schemaId: Hex;
    owner: Address;
    entryCount: number;
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

    // ── Core generic publish ──────────────────────────────────────────────────

    async publish<TIn, TMan extends { kind: string; schemaId: Hex; root: Hex; tree: Hex[][] }>(params: {
        schemaName: string;
        builder: ManifestBuilder<TIn, TMan>;
        input: TIn;
        datasetName?: string;
        concurrency?: number;
    }): Promise<CommitResult> {
        const { schemaName, builder, input, datasetName, concurrency = 10 } = params;
        const { schema, schemaId } = await this.resolveSchema(schemaName);

        await builder.validate(schema, input);

        // Bounded-inflight upload: the chunk generator is pulled only as fast as
        // uploads drain, so at most `concurrency` chunks (their `draft.data`) are
        // held in memory at once — regardless of total dataset size.
        const chunks: ChunkRef[] = [];
        const inFlight = new Set<Promise<unknown>>();
        let firstErr: unknown;
        let idx = 0n;

        for await (const draft of builder.chunk(input, schema)) {
            if (firstErr) break;
            const myIdx = idx++; // assigned in generation order — preserves leaf indexing
            const task = (async () => {
                const cid = await this.storage.put(draft.data, { name: draft.name });
                chunks.push({ index: myIdx, cid, name: draft.name, meta: draft.meta });
            })().catch((e: unknown) => { firstErr ??= e; });
            inFlight.add(task);
            void task.finally(() => inFlight.delete(task));
            // `while`, not `if`: the settled task's `.finally` delete may not have
            // run yet when Promise.race resolves, so keep draining until under cap.
            while (inFlight.size >= concurrency) await Promise.race(inFlight);
        }

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
        const owner = this.requireAccount();
        const manifestCid = await this.storage.put(manifest, {
            name: `manifest:${builder.kind}:${schemaId}:${Date.now().toString()}`,
        });
        const ds = datasetName ?? `${schemaId}:${owner}`;
        await this.dataSourceRegistry.publish(manifestCid, context.root, schemaId, ds);

        return { manifestUri: manifestCid, schemaId, owner, entryCount: chunks.length };
    }

    // ── Convenience wrappers ──────────────────────────────────────────────────

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

    async publishBundle(params: {
        bundleName: string;
        nodes: { id: string; type: string; fields: Record<string, FieldInput> }[] | AsyncIterable<{ id: string; type: string; fields: Record<string, FieldInput> }>;
        edges?: { rel: string; from: string; to: string }[] | AsyncIterable<{ rel: string; from: string; to: string }>;
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

    // ── Read methods ──────────────────────────────────────────────────────────

    async readBundle(manifest: BundleManifest): Promise<HydratedBundle> {
        const nodeArrays = await Promise.all(
            manifest.nodeChunks.map(chunk => this.storage.get<BundleNode[]>(chunk.dataCid)),
        );
        // Many edge leaves (current) or a single edgeChunk (older manifests).
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

    // ── Private helpers ───────────────────────────────────────────────────────

    private resolveSchema(name: string): Promise<{ schema: ResolvedSchemaShape; schemaId: Hex }> {
        const cached = this.schemaCache.get(name);
        if (cached) return cached;

        const p = Promise.all([
            this.schemaRegistry.getSchema(name),
            this.schemaRegistry.schemaId(name),
        ]).then(async ([{ specCid }, schemaId]) => {
            const blob = await this.storage.get<{ definition?: SchemaDefinition; bundle?: ResolvedBundle }>(specCid);
            const schema = blob.bundle ?? blob.definition;
            if (!schema) throw new Error(`schema "${name}" has neither definition nor bundle`);
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
