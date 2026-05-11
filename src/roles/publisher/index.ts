import { type Address, type Hex, type WalletClient } from "viem";
import { FieldDefinition, SchemaDefinition } from "../schema/types";
import { DataSourceRegistry } from "../../registries/datasource-registry";
import { MetadataStorage } from "../../providers/storage/types";
import {
    CommitResult,
    FieldInput,
    FieldInputObject,
    HandleFieldInput,
    Manifest,
    ManifestEntry,
    PublishRecord,
    ResolvedField,
    ResolvedHandleField,
    UploadParams,
} from "./types";
import { AppConfig } from "../../config";
import { SchemaRegistry } from "../../registries/schema-registry";

export * from "./types";

export class PublisherRole {

    private pendingEntries = new Map<string, ManifestEntry>();
    private readonly schemaCache = new Map<string, Promise<{ schema: SchemaDefinition; schemaId: Hex }>>();

    constructor(
        private readonly dataSourceRegistry: DataSourceRegistry,
        private readonly schemaRegistry: SchemaRegistry,
        private readonly storage: MetadataStorage,
        private readonly walletClient: WalletClient,
        private readonly config: AppConfig,
    ) { }

    /**
     * Validate and stage schema-conformant records, then commit to storage
     * and publish on-chain.
     */
    async upload(params: UploadParams, price: bigint): Promise<CommitResult> {
        const { records, schemaName, options } = params;

        const { schema, schemaId } = await this.resolveSchema(schemaName);

        for (const record of records) {
            this.validateRecord(record, schema);
            const entry = this.resolveRecord(record, schema, price);
            this.pendingEntries.set(record.name, entry);
        }

        return this.commit(schemaId, price, options?.overwrite ?? false);
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

    /**
     * Serialize all staged entries into manifests, upload to storage,
     * and publish each manifest CID on-chain.
     */
    async commit(schemaId: Hex, price: bigint, overwrite: boolean): Promise<CommitResult> {
        const owner = this.requireAccount();

        if (this.pendingEntries.size === 0) {
            throw new Error("Nothing to commit. Stage at least one record.");
        }

        let entries = Array.from(this.pendingEntries.values());

        if (!overwrite) {
            entries = await this.filterNewEntries(owner, schemaId, entries);
            if (entries.length === 0) {
                this.pendingEntries.clear();
                throw new Error(
                    "All staged entries already exist on-chain. " +
                    "Use overwrite: true to force re-publish."
                );
            }
        }

        const results: { entry: ManifestEntry; manifestUri: string }[] = [];

        for (const entry of entries) {
            const manifest: Manifest = {
                version: 2,
                schemaId,
                entries: [entry],
            };
            const manifestUri = await this.storage.put(manifest, {
                name: `manifest:${schemaId}:${entry.name}`,
            });
            await this.dataSourceRegistry.publish(manifestUri, schemaId, entry.name, price);
            results.push({ entry, manifestUri });
        }

        this.pendingEntries.clear();

        return {
            manifestUri: results[results.length - 1]?.manifestUri ?? "",
            schemaId,
            owner,
            entryCount: results.length,
        };
    }

    async getManifest(schemaId: Hex, name: string): Promise<Manifest | undefined> {
        const owner = this.requireAccount();
        try {
            const ds = await this.dataSourceRegistry.get(owner, schemaId, name);
            if (!ds.manifestCid || ds.manifestCid === "") return undefined;
            return await this.storage.get<Manifest>(ds.manifestCid);
        } catch {
            return undefined;
        }
    }

    async getEntry(schemaId: Hex, name: string): Promise<ManifestEntry> {
        const manifest = await this.getManifest(schemaId, name);
        if (!manifest) throw new Error(`No manifest found for schemaId ${schemaId} / name ${name}`);
        const entry = manifest.entries.find((e) => e.name === name);
        if (!entry) throw new Error(`Entry not found: "${name}"`);
        return entry;
    }

    private requireAccount(): Address {
        const address = this.walletClient.account?.address;
        if (!address) throw new Error("No account connected to wallet client");
        return address;
    }

    private resolveSchema(name: string): Promise<{ schema: SchemaDefinition; schemaId: Hex }> {
        if (!this.schemaCache.has(name)) {
            const p = Promise.all([
                this.schemaRegistry.getSchema(name),
                this.schemaRegistry.schemaId(name),
            ])
                .then(async ([{ specCid }, schemaId]) => {
                    const registered = await this.storage.get<{ definition: SchemaDefinition }>(specCid);
                    return { schema: registered.definition, schemaId };
                })
                .catch((err: unknown) => {
                    this.schemaCache.delete(name);
                    throw err;
                });

            this.schemaCache.set(name, p);
        }

        const cached = this.schemaCache.get(name);
        if (!cached) throw new Error(`Schema not found in cache: ${name}`);
        return cached;
    }

    /**
     * Resolve a PublishRecord into a ManifestEntry.
     * Handle fields are passed through directly; plain fields stored inline.
     */
    private resolveRecord(
        record: PublishRecord,
        schema: SchemaDefinition,
        price: bigint,
    ): ManifestEntry {
        const resolvedFields: Record<string, ResolvedField> = {};

        for (const [fieldName] of Object.entries(schema)) {
            const value = record.fields[fieldName];

            if (isHandleFieldInput(value)) {
                resolvedFields[fieldName] = {
                    "@type": "handle",
                    uri: value.uri,
                    workerUrl: value.workerUrl,
                    price: price.toString(),
                } satisfies ResolvedHandleField;
            } else {
                resolvedFields[fieldName] = value as ResolvedField;
            }
        }

        return { name: record.name, fields: resolvedFields };
    }

    private validateRecord(record: PublishRecord, schema: SchemaDefinition): void {
        const errors: string[] = [];

        for (const [fieldName, fieldDef] of Object.entries(schema)) {
            this.validateField(record.name, fieldName, fieldDef, record.fields[fieldName], errors);
        }

        for (const fieldName of Object.keys(record.fields)) {
            if (!(fieldName in schema)) {
                console.warn(`Record "${record.name}": field "${fieldName}" is not in the schema and will be ignored`);
            }
        }

        if (errors.length > 0) {
            throw new Error(
                `Validation failed for record "${record.name}":\n` +
                errors.map((e) => `  • ${e}`).join("\n"),
            );
        }
    }

    private validateField(
        name: string,
        fieldName: string,
        fieldDef: FieldDefinition,
        value: FieldInput,
        errors: string[],
    ): void {
        // Handle fields bypass schema type checks — URI correctness is the
        // publisher's responsibility.
        if (isHandleFieldInput(value)) return;

        const rawType = fieldDef["@type"];
        const nullable = rawType.includes("| null");
        const baseType = rawType.replace("| null", "").trim();

        if (value === null) {
            if (!nullable) {
                errors.push(`"${fieldName}" is required (non-nullable), got null`);
            }
            return;
        }

        switch (baseType) {
            case "string":
                if (typeof value !== "string")
                    errors.push(`"${fieldName}" must be a string, got ${typeof value}`);
                break;

            case "number":
                if (typeof value !== "number")
                    errors.push(`"${fieldName}" must be a number, got ${typeof value}`);
                break;

            case "boolean":
                if (typeof value !== "boolean")
                    errors.push(`"${fieldName}" must be a boolean, got ${typeof value}`);
                break;

            case "bytes":
                if (!(value instanceof Uint8Array))
                    errors.push(`"${fieldName}" must be Uint8Array`);
                break;

            case "array": {
                if (!Array.isArray(value)) {
                    errors.push(`"${fieldName}" must be an array, got ${typeof value}`);
                    break;
                }
                const itemDef = fieldDef.items;
                if (itemDef && "@type" in itemDef) {
                    (value as FieldInput[]).forEach((item, i) => {
                        this.validateField(
                            name,
                            `${fieldName}[${i.toString()}]`,
                            itemDef as FieldDefinition,
                            item,
                            errors,
                        );
                    });
                }
                break;
            }

            case "object": {
                if (typeof value !== "object" || Array.isArray(value)) {
                    errors.push(`"${fieldName}" must be an object, got ${typeof value}`);
                    break;
                }
                const itemsDef = fieldDef.items;
                if (itemsDef && !("@type" in itemsDef)) {
                    for (const [subField, subDef] of Object.entries(itemsDef)) {
                        this.validateField(
                            name,
                            `${fieldName}.${subField}`,
                            subDef,
                            (value as FieldInputObject)[subField],
                            errors,
                        );
                    }
                }
                break;
            }

            default:
                console.warn(`Record "${name}" field "${fieldName}": unknown @type "${baseType}", skipping validation`);
        }
    }

    /**
     * Return only entries whose names do not already exist on-chain
     * for this (owner, schemaId) pair.
     */
    private async filterNewEntries(
        owner: Address,
        schemaId: Hex,
        pendingEntries: ManifestEntry[],
    ): Promise<ManifestEntry[]> {
        const results = await Promise.allSettled(
            pendingEntries.map(async (entry) => {
                try {
                    const ds = await this.dataSourceRegistry.get(owner, schemaId, entry.name);
                    const exists = ds.manifestCid && ds.manifestCid !== "";
                    return { entry, exists };
                } catch {
                    return { entry, exists: false };
                }
            })
        );

        const newEntries: ManifestEntry[] = [];
        for (const result of results) {
            if (result.status === "fulfilled" && !result.value.exists) {
                newEntries.push(result.value.entry);
            } else if (result.status === "rejected") {
                console.warn("Failed to check entry existence, including conservatively:", result.reason);
            }
        }

        return newEntries;
    }
}

function isHandleFieldInput(value: FieldInput): value is HandleFieldInput {
    return (
        typeof value === "object" &&
        value !== null &&
        "@type" in value &&
        (value as Record<string, unknown>)["@type"] === "handle"
    );
}