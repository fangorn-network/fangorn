import { type Address, type Hex, type WalletClient } from "viem";
import { ResolvedBundle, SchemaDefinition } from "../schema/types";
import { DataSourceRegistry, MerkleTree } from "../../registries/datasource-registry";
import { MetadataStorage } from "../../providers/storage/types";
import { AppConfig } from "../../config";
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

/**
 * A helper function for concurrency managment
 * to limit the number of active threads when uploading bulk data
 * @param concurrency The number of threads to run
 * @returns 
 */
function createLimiter(concurrency: number) {
    const queue: (() => void)[] = [];
    let active = 0;
    const next = () => {
        active--;
        if (queue.length > 0) { active++; queue.shift()!(); }
    };
    return async <T>(fn: () => Promise<T>): Promise<T> => {
        if (active >= concurrency) await new Promise<void>(r => queue.push(r));
        active++;
        try { return await fn(); } finally { next(); }
    };
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
        _config: AppConfig,
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

        const limit = createLimiter(concurrency);
        const uploadTasks: Promise<ChunkRef>[] = [];
        let idx = 0n;

        for await (const draft of builder.chunk(input, schema)) {
            const myIdx = idx++;
            uploadTasks.push(limit(async () => {
                const cid = await this.storage.put(draft.data, { name: draft.name });
                return { index: myIdx, cid, name: draft.name, meta: draft.meta };
            }));
        }

        const chunks = await Promise.all(uploadTasks);
        if (chunks.length === 0) throw new Error("builder produced no chunks");

        chunks.sort(builder.compareChunks);

        const leafInputs = chunks.map(c => ({ index: c.index, name: c.cid }));
        const leaves: Hex[] = leafInputs.map(l => MerkleTree.rootToHex(MerkleTree.leafHash(l)));
        const { root, layers } = MerkleTree.buildTree(leafInputs);

        const context: BuildContext = {
            schemaId,
            chunks,
            leaves,
            root: MerkleTree.rootToHex(root),
            layers: layers.map(layer => layer.map(MerkleTree.rootToHex)),
        };

        const manifest = builder.assemble(context, input, schema);
        const owner = this.requireAccount();
        const manifestCid = await this.storage.put(manifest, {
            name: `manifest:${builder.kind}:${schemaId}:${Date.now()}`,
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
        nodes: { id: string; type: string; fields: Record<string, FieldInput> }[];
        edges?: { rel: string; from: string; to: string }[];
        datasetName?: string;
        concurrency?: number;
    }): Promise<CommitResult> {
        return this.publish({
            schemaName: params.bundleName,
            builder: new BundleBuilder(this.storage, this.schemaRegistry),
            input: {
                bundleName: params.bundleName,
                nodes: params.nodes,
                edges: params.edges,
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
        const edges = await this.storage.get<BundleEdge[]>(manifest.edgeChunk.dataCid);
        const nodesById = new Map<string, BundleNode>();
        for (const nodes of nodeArrays) {
            for (const node of nodes) nodesById.set(node.id, node);
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
            if (!dataCid) continue;
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
            if (manifest?.kind !== "bundle") return undefined;
            return manifest;
        } catch { return undefined; }
    }

    async getBundleManifest(bundleName: string, datasetName: string): Promise<BundleManifest | undefined> {
        const bundleSchemaId = await this.schemaRegistry.schemaId(bundleName);
        const owner = this.requireAccount();
        try {
            const ds = await this.dataSourceRegistry.get(owner, bundleSchemaId, datasetName);
            if (!ds.manifestCid) return undefined;
            return this.getBundleManifestByCid(ds.manifestCid);
        } catch { return undefined; }
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    private resolveSchema(name: string): Promise<{ schema: ResolvedSchemaShape; schemaId: Hex }> {
        if (!this.schemaCache.has(name)) {
            const p = Promise.all([
                this.schemaRegistry.getSchema(name),
                this.schemaRegistry.schemaId(name),
            ]).then(async ([{ specCid }, schemaId]) => {
                const blob = await this.storage.get<{ definition?: SchemaDefinition; bundle?: ResolvedBundle }>(specCid);
                const schema: ResolvedSchemaShape = blob.bundle ?? blob.definition!;
                if (!schema) throw new Error(`schema "${name}" has neither definition nor bundle`);
                return { schema, schemaId };
            }).catch(err => { this.schemaCache.delete(name); throw err; });
            this.schemaCache.set(name, p);
        }
        return this.schemaCache.get(name)!;
    }

    private requireAccount(): Address {
        const address = this.walletClient.account?.address;
        if (!address) throw new Error("No account connected");
        return address;
    }
}
