import { type Address, type Hex, type WalletClient } from "viem";
import { FieldDefinition, ResolvedBundle, SchemaDefinition } from "../schema/types";
import { DataSourceRegistry, MerkleTree } from "../../registries/datasource-registry";
import { MetadataStorage } from "../../providers/storage/types";
import { AppConfig } from "../../config";
import { SchemaRegistry } from "../../registries/schema-registry";
import {
    FieldInput,
    Manifest,
    PublishRecord,
    ResolvedField,
    ResolvedHandleField,
    ManifestEntry,
    HandleFieldInput,
    BundleManifest,
    BundleNode,
    HydratedBundle,
    BundleEdge
} from "./types";

/**
 * Upload params
 */

export interface UploadParams {
    records: PublishRecord[];

    schemaName: string;

    gas?: bigint;

    options?: {
        overwrite?: boolean;
    };
}

/**
 * Commit result
 */

export interface CommitResult {
    manifestUri: string;
    schemaId: Hex;
    owner: Address;
    entryCount: number;
}1

function createLimiter(concurrency: number) {
    const queue: (() => void)[] = [];
    let active = 0;

    const next = () => {
        active--;
        if (queue.length > 0) {
            const nextTask = queue.shift();
            if (nextTask) {
                active++;
                nextTask();
            }
        }
    };

    return async <T>(fn: () => Promise<T>): Promise<T> => {
        if (active >= concurrency) {
            await new Promise<void>((resolve) => queue.push(resolve));
        }
        active++;
        try {
            return await fn();
        } catch (err) {
            throw err;
        } finally {
            next();
        }
    };
}

function isAsyncIterable<T>(val: any): val is AsyncIterable<T> {
    return val !== null && typeof val === "object" && Symbol.asyncIterator in val;
}

export class PublisherRole {
    private pendingEntries = new Map<string, ManifestEntry>();

    private readonly schemaCache = new Map<
        string,
        Promise<{ schema: SchemaDefinition; schemaId: Hex }>
    >();

    constructor(
        private readonly dataSourceRegistry: DataSourceRegistry,
        private readonly schemaRegistry: SchemaRegistry,
        private readonly storage: MetadataStorage,
        private readonly walletClient: WalletClient,
        private readonly config: AppConfig,
    ) { }

    // TODO: should these be added to params?
    async upload(params: UploadParams & { chunkSize?: number; concurrency?: number; datasetName?: string }): Promise<CommitResult> {
        const { records, schemaName, options, chunkSize = 1000, concurrency = 10, datasetName } = params;

        const { schema, schemaId } = await this.resolveSchema(schemaName);
        const limit = createLimiter(concurrency);

        const chunkLeafInputs: { index: bigint; cid: string; chunkName: string }[] = [];
        let currentChunkEntries: ManifestEntry[] = [];
        let leafIndex = 0;
        const uploadPromises: Promise<any>[] = [];

        const processAndQueueChunk = (entriesToUpload: ManifestEntry[], index: number) => {
            const chunkName = `chunk:${schemaId}:${index}`;

            const task = limit(async () => {
                const dataCid = await this.storage.put(entriesToUpload, {
                    name: chunkName,
                });
                return { index: BigInt(index), cid: dataCid, chunkName };
            });

            uploadPromises.push(task.then(res => chunkLeafInputs.push(res)));
        };

        if (isAsyncIterable<PublishRecord>(records)) {
            let count = 0;
            for await (const record of records) {
                this.validateRecord(record, schema);
                currentChunkEntries.push(this.resolveRecord(record, schema));
                count++;

                if (count % chunkSize === 0) {
                    processAndQueueChunk(currentChunkEntries, leafIndex++);
                    currentChunkEntries = [];
                }
            }
        } else {
            const recordArray = records as PublishRecord[];
            for (let i = 0; i < recordArray.length; i += chunkSize) {
                const slice = recordArray.slice(i, i + chunkSize);
                const processed = slice.map(record => {
                    this.validateRecord(record, schema);
                    return this.resolveRecord(record, schema);
                });
                processAndQueueChunk(processed, leafIndex++);
            }
        }

        if (currentChunkEntries.length > 0) {
            processAndQueueChunk(currentChunkEntries, leafIndex++);
        }

        await Promise.all(uploadPromises);

        if (chunkLeafInputs.length === 0) {
            throw new Error("No data records processed inside request payload.");
        }

        chunkLeafInputs.sort((a, b) => a.cid.localeCompare(b.cid));

        return this.commitChunkedTree(schemaId, chunkLeafInputs, datasetName);
    }

    stage(entry: ManifestEntry): void {
        this.pendingEntries.set(entry.name, entry);
    }

    remove(name: string): boolean {
        return this.pendingEntries.delete(name);
    }

    getPending(): ManifestEntry[] {
        return Array.from(this.pendingEntries.values());
    }

    clearPending(): void {
        this.pendingEntries.clear();
    }

    private async commitChunkedTree(
        schemaId: Hex,
        chunkLeafInputs: { index: bigint; cid: string; chunkName: string }[],
        customDatasetName?: string
    ): Promise<CommitResult> {
        const owner = this.requireAccount();

        const leafInputs = chunkLeafInputs.map((chunk) => ({
            index: chunk.index,
            name: chunk.cid,
        }));

        const leaves = leafInputs.map(l => MerkleTree.leafHash(l));
        const { root, layers } = MerkleTree.buildTree(leafInputs);

        const manifest: Manifest = {
            version: 2,
            schemaId,
            root: MerkleTree.rootToHex(root),

            entries: chunkLeafInputs.map((chunk, i): ManifestEntry => ({
                name: chunk.chunkName,
                fields: {
                    dataCid: chunk.cid,
                    leaf: MerkleTree.rootToHex(leaves[i])
                }
            })),

            tree: layers.map(layer => layer.map(MerkleTree.rootToHex)),
        };

        const manifestName = `manifest:${schemaId}:${Date.now().toString()}`;
        const manifestCid = await this.storage.put(manifest, { name: manifestName });

        // Fallback to defaults if a dedicated test/custom execution name isn't given
        const datasetName = customDatasetName ?? `${schemaId}:${owner}`;

        await this.dataSourceRegistry.publish(
            manifestCid,
            MerkleTree.rootToHex(root),
            schemaId,
            datasetName,
        );


        this.pendingEntries.clear();

        return {
            manifestUri: manifestCid,
            schemaId,
            owner,
            entryCount: chunkLeafInputs.length,
        };
    }

    async commit(schemaId: Hex, overwrite: boolean, customDatasetName?: string): Promise<CommitResult> {
        const owner = this.requireAccount();
        if (this.pendingEntries.size === 0) {
            throw new Error("Nothing to commit; Stage entries with `upload` first.");
        }

        let entries = Array.from(this.pendingEntries.values());
        if (!overwrite) {
            entries = await this.filterNewEntries(owner, schemaId, entries);
        }

        if (entries.length === 0) {
            throw new Error("No new entries to publish");
        }

        const chunkLeafInputs = await Promise.all(entries.map(async (entry, idx) => {
            const dataCid = await this.storage.put(entry.fields, { name: `legacy:${entry.name}` });
            return { index: BigInt(idx), cid: dataCid, chunkName: entry.name };
        }));

        return this.commitChunkedTree(schemaId, chunkLeafInputs, customDatasetName);
    }

    /**
     * Uploads a 'bundle' to Fangorn
     * 
     * A bundle is a small subgraph that defines the 'shape' of the data by defining relationships
     * that cut across multiple schemas, allowing for data to be published relative to a  *set* of schemas
     * rather than a single one.
     * 
     * @param params 
     * @returns 
     */
    async uploadBundle(params: {
        bundleName: string;
        nodes: { id: string; type: string; fields: Record<string, FieldInput> }[];
        edges?: { rel: string; from: string; to: string }[];
        datasetName?: string;
        concurrency?: number;
    }): Promise<CommitResult> {
        const { bundleName, nodes, edges = [], datasetName, concurrency = 10 } = params;
        if (nodes.length === 0) throw new Error("Bundle has no nodes");

        const { bundle, bundleSchemaId } = await this.resolveBundleShape(bundleName);

        // resolver definition per declared node type (for record validation)
        const defByType = new Map<string, SchemaDefinition>();
        await Promise.all(
            Object.entries(bundle.nodes).map(async ([type, schemaId]) => {
                defByType.set(type, await this.resolveNodeDefinition(schemaId));
            }),
        );

        // validate + resolve each node, grouped by type
        const nodeType = new Map<string, string>();        // id -> type
        const seen = new Set<string>();
        const byType = new Map<string, BundleNode[]>();

        for (const node of nodes) {
            if (!(node.type in bundle.nodes)) throw new Error(`node "${node.id}" has undeclared type "${node.type}"`);
            if (seen.has(node.id)) throw new Error(`duplicate node id "${node.id}"`);
            seen.add(node.id);
            nodeType.set(node.id, node.type);

            const def = defByType.get(node.type)!;
            const record = { name: node.id, fields: node.fields } as PublishRecord;
            this.validateRecord(record, def);                 // throws on bad field
            const resolved = this.resolveRecord(record, def); // handles handle-fields
            const list = byType.get(node.type) ?? [];
            list.push({ id: node.id, type: node.type, fields: resolved.fields });
            byType.set(node.type, list);
        }

        // edge validation: existence, declared-relation closure, cardinality
        this.validateBundleEdges(bundle, edges, nodeType);

        // chunk + upload nodes by type, plus the edge set as its own chunk
        const limit = createLimiter(concurrency);
        const nodeChunks: { type: string; dataCid: string }[] = [];
        const uploads: Promise<void>[] = [];

        for (const [type, typeNodes] of byType) {
            uploads.push(limit(async () => {
                const cid = await this.storage.put(typeNodes, { name: `bundle-node:${bundleSchemaId}:${type}` });
                nodeChunks.push({ type, dataCid: cid });
            }));
        }
        let edgeCid = "";
        uploads.push(limit(async () => {
            edgeCid = await this.storage.put(edges, { name: `bundle-edges:${bundleSchemaId}` });
        }));
        await Promise.all(uploads);

        nodeChunks.sort((a, b) => a.type.localeCompare(b.type)); // deterministic leaf order

        return this.commitBundleTree(bundleSchemaId, nodeChunks, { dataCid: edgeCid }, datasetName);
    }

    private validateBundleEdges(
        bundle: ResolvedBundle,
        edges: { rel: string; from: string; to: string }[],
        nodeType: Map<string, string>,
    ): void {
        const errors: string[] = [];
        const declared = new Set(bundle.edges.map(e => `${e.rel}:${e.from}:${e.to}`));

        // existence + closed-world: every instance edge must match a declared (rel, fromType, toType)
        edges.forEach((edge, i) => {
            const ft = nodeType.get(edge.from);
            const tt = nodeType.get(edge.to);
            if (!ft) return errors.push(`edge[${i}] "${edge.rel}" from unknown node "${edge.from}"`);
            if (!tt) return errors.push(`edge[${i}] "${edge.rel}" to unknown node "${edge.to}"`);
            if (!declared.has(`${edge.rel}:${ft}:${tt}`))
                errors.push(`edge[${i}] undeclared relation "${edge.rel}" (${ft} → ${tt})`);
        });

        // cardinality per source node, per declared edge shape (SHACL min/maxCount semantics)
        for (const shape of bundle.edges) {
            const min = shape.min ?? 0;
            const max = shape.max ?? null;
            for (const [id, type] of nodeType) {
                if (type !== shape.from) continue;
                const count = edges.filter(
                    e => e.rel === shape.rel && e.from === id && nodeType.get(e.to) === shape.to,
                ).length;
                if (count < min) errors.push(`node "${id}" has ${count} "${shape.rel}" edges, needs min ${min}`);
                if (max !== null && count > max) errors.push(`node "${id}" has ${count} "${shape.rel}" edges, exceeds max ${max}`);
            }
        }

        if (errors.length) throw new Error("Bundle edge validation failed:\n" + errors.map(e => ` - ${e}`).join("\n"));
    }

    private async commitBundleTree(
        bundleSchemaId: Hex,
        nodeChunks: { type: string; dataCid: string }[],
        edgeChunk: { dataCid: string },
        datasetName?: string,
    ): Promise<CommitResult> {
        const owner = this.requireAccount();

        // leaves: node chunks (sorted) then edge chunk last
        const ordered = [...nodeChunks.map(c => c.dataCid), edgeChunk.dataCid];
        const leafInputs = ordered.map((cid, i) => ({ index: BigInt(i), name: cid }));
        const leaves = leafInputs.map(l => MerkleTree.leafHash(l));
        const { root, layers } = MerkleTree.buildTree(leafInputs);

        const manifest: BundleManifest = {
            version: 3,
            bundleSchemaId,
            root: MerkleTree.rootToHex(root),
            nodeChunks: nodeChunks.map((c, i) => ({
                type: c.type,
                dataCid: c.dataCid,
                leaf: MerkleTree.rootToHex(leaves[i]),
            })),
            edgeChunk: {
                dataCid: edgeChunk.dataCid,
                leaf: MerkleTree.rootToHex(leaves[nodeChunks.length]),
            },
            tree: layers.map(layer => layer.map(MerkleTree.rootToHex)),
        };

        const manifestCid = await this.storage.put(manifest, {
            name: `bundle-manifest:${bundleSchemaId}:${Date.now()}`,
        });
        const ds = datasetName ?? `${bundleSchemaId}:${owner}`;

        await this.dataSourceRegistry.publish(manifestCid, MerkleTree.rootToHex(root), bundleSchemaId, ds);

        return {
            manifestUri: manifestCid,
            schemaId: bundleSchemaId,
            owner,
            entryCount: nodeChunks.length + 1,
        };
    }

    /**
 * Fetch a bundle's node + edge chunks and return the graph in memory.
 * The manifest holds CIDs (pointers); this follows them to the real data.
 */
    async readBundle(manifest: BundleManifest): Promise<HydratedBundle> {
        // follow every node-chunk CID -> arrays of BundleNode, in parallel
        const nodeArrays = await Promise.all(
            manifest.nodeChunks.map(chunk =>
                this.storage.get<BundleNode[]>(chunk.dataCid),
            ),
        );

        // follow the edge-chunk CID -> the edge set
        const edges = await this.storage.get<BundleEdge[]>(manifest.edgeChunk.dataCid);

        // index every node by id so edge walks are O(1) lookups
        const nodesById = new Map<string, BundleNode>();
        for (const nodes of nodeArrays) {
            for (const node of nodes) {
                nodesById.set(node.id, node);
            }
        }

        return { nodesById, edges };
    }

    private async resolveBundleShape(name: string): Promise<{ bundle: ResolvedBundle; bundleSchemaId: Hex }> {
        const [{ specCid }, bundleSchemaId] = await Promise.all([
            this.schemaRegistry.getSchema(name),
            this.schemaRegistry.schemaId(name),
        ]);
        const blob = await this.storage.get<{ bundle?: ResolvedBundle }>(specCid);
        if (!blob.bundle) throw new Error(`Schema "${name}" is not a bundle`);
        return { bundle: blob.bundle, bundleSchemaId };
    }

    private async resolveNodeDefinition(schemaId: Hex): Promise<SchemaDefinition> {
        const { specCid } = await this.schemaRegistry.getSchema(schemaId);
        const blob = await this.storage.get<{ definition?: SchemaDefinition }>(specCid);
        if (!blob.definition) throw new Error(`node schema ${schemaId} is not a resolver schema`);
        return blob.definition;
    }

    async getManifest(schemaName: string, datasetName: string): Promise<Manifest | undefined> {
        const schemaId = (await this.resolveSchema(schemaName)).schemaId;
        console.log('schema id ' + schemaId)
        const owner = this.requireAccount();
        try {
            const ds = await this.dataSourceRegistry.get(owner, schemaId, datasetName);
            if (!ds.manifestCid) return undefined;
            return await this.storage.get<Manifest>(ds.manifestCid);
        } catch (err) {
            console.log(err);
            return undefined;
        }
    }

    async getEntry(schemaName: string, datasetName: string, recordName: string): Promise<ManifestEntry> {
        const manifest = await this.getManifest(schemaName, datasetName);

        if (!manifest) {
            throw new Error(`No manifest found for schema ${schemaName} under dataset ${datasetName}`);
        }

        // look through the chunks for the specific record name
        for (const chunkEntry of manifest.entries) {
            const dataCid = chunkEntry.fields.dataCid;
            if (!dataCid) continue;

            try {
                const chunkRecords = await this.storage.get<ManifestEntry[]>(dataCid);
                const foundRecord = chunkRecords.find(record => record.name === recordName);
                if (foundRecord) {
                    return foundRecord;
                }
            } catch {
                continue;
            }
        }

        throw new Error(`Entry "${recordName}" not found across any dataset chunks in ${datasetName}`);
    }

    /** Read a v3 bundle manifest directly by its CID. */
    async getBundleManifestByCid(manifestCid: string): Promise<BundleManifest | undefined> {
        try {
            const manifest = await this.storage.get<BundleManifest>(manifestCid);
            if (manifest?.version !== 3) return undefined;
            return manifest;
        } catch (err) {
            console.error(err);
            return undefined;
        }
    }

    /** Look up a bundle's v3 manifest by owner + bundle name + dataset. */
    async getBundleManifest(bundleName: string, datasetName: string): Promise<BundleManifest | undefined> {
        const bundleSchemaId = await this.schemaRegistry.schemaId(bundleName);
        const owner = this.requireAccount();
        try {
            const ds = await this.dataSourceRegistry.get(owner, bundleSchemaId, datasetName);
            if (!ds.manifestCid) return undefined;
            return this.getBundleManifestByCid(ds.manifestCid);
        } catch (err) {
            console.error(err);
            return undefined;
        }
    }

    private requireAccount(): Address {
        const address = this.walletClient.account?.address;
        if (!address) throw new Error("No account connected");
        return address;
    }

    private resolveSchema(name: string) {
        // if no local cache for a schema, try to fetch it
        if (!this.schemaCache.has(name)) {
            const p = Promise.all([
                this.schemaRegistry.getSchema(name),
                this.schemaRegistry.schemaId(name),
            ]).then(async ([{ specCid }, schemaId]) => {
                const registered = await this.storage.get<{ definition: SchemaDefinition }>(specCid);
                return { schema: registered.definition, schemaId };
            }).catch(err => {
                this.schemaCache.delete(name);
                throw err;
            });
            this.schemaCache.set(name, p);
        }

        const cached = this.schemaCache.get(name);

        if (!cached) throw new Error("Schema cache failure");
        return cached;
    }

    private resolveRecord(record: PublishRecord, schema: SchemaDefinition): ManifestEntry {
        const resolved: Record<string, ResolvedField> = {};

        for (const [fieldName] of Object.entries(schema)) {
            const value = record.fields[fieldName];

            if (isHandleFieldInput(value)) {
                resolved[fieldName] = {
                    "@type": "handle",
                    uri: value.uri,
                    workerUrl: value.workerUrl,
                } satisfies ResolvedHandleField;
            } else {
                resolved[fieldName] = value as ResolvedField;
            }
        }

        return {
            name: record.name,
            fields: resolved,
        };
    }

    private validateRecord(record: PublishRecord, schema: SchemaDefinition): void {
        const errors: string[] = [];
        for (const [fieldName, fieldDef] of Object.entries(schema)) {
            this.validateField(record.name, fieldName, fieldDef, record.fields[fieldName], errors);
        }
        if (errors.length > 0) {
            throw new Error(`Validation failed for "${record.name}":\n` + errors.map(e => ` - ${e}`).join("\n"));
        }
    }

    private validateField(name: string, fieldName: string, fieldDef: FieldDefinition, value: FieldInput, errors: string[]): void {
        if (isHandleFieldInput(value)) return;
        const rawType = fieldDef["@type"];
        const nullable = rawType.includes("| null");
        const baseType = rawType.replace("| null", "").trim();

        if (value === null) {
            if (!nullable) errors.push(`"${fieldName}" is required`);
            return;
        }

        switch (baseType) {
            case "string": if (typeof value !== "string") errors.push(`${fieldName} must be string`); break;
            case "number": if (typeof value !== "number") errors.push(`${fieldName} must be number`); break;
            case "boolean": if (typeof value !== "boolean") errors.push(`${fieldName} must be boolean`); break;
            case "bytes": if (!((value as unknown) instanceof Uint8Array)) errors.push(`${fieldName} must be bytes`); break;
        }
    }

    private async filterNewEntries(owner: Address, schemaId: Hex, pendingEntries: ManifestEntry[]): Promise<ManifestEntry[]> {
        const results = await Promise.allSettled(
            pendingEntries.map(async entry => {
                try {
                    const ds = await this.dataSourceRegistry.get(owner, schemaId, entry.name);
                    return { entry, exists: !!ds.manifestCid };
                } catch {
                    return { entry, exists: false };
                }
            }),
        );
        return results
            .filter(r => r.status === "fulfilled" && !r.value.exists)
            .map(r => (r as PromiseFulfilledResult<any>).value.entry);
    }
}

function isHandleFieldInput(value: FieldInput): value is HandleFieldInput {
    return (
        typeof value === "object" &&
        value !== null &&
        "@type" in value &&
        (value as any)["@type"] === "handle"
    );
}