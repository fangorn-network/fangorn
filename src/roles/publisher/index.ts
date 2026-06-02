import { type Address, type Hex, type WalletClient } from "viem";
import { FieldDefinition, SchemaDefinition } from "../schema/types";
import { DataSourceRegistry, MerkleTree } from "../../registries/datasource-registry";
import { MetadataStorage } from "../../providers/storage/types";
import { AppConfig } from "../../config";
import { SchemaRegistry } from "../../registries/schema-registry";
import {
    CommitResult,
    FieldInput,
    Manifest,
    PublishRecord,
    ResolvedField,
    ResolvedHandleField,
    UploadParams,
    ManifestEntry,
    HandleFieldInput
} from "./types";

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