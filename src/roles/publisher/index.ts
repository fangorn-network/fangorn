import { type Address, type Hex, type WalletClient } from "viem";
import { FieldDefinition, SchemaDefinition } from "../schema/types";
import { DataSourceRegistry } from "../../registries/datasource-registry";
import { MetadataStorage } from "../../providers/storage/types";
import {
    CommitResult,
    FieldInput,
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

export * from './types';

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
     *
     * Fields with a HandleFieldInput are written to the manifest as-is. 
     * The content is assumed to already exist at the supplied URI (e.g. pre-uploaded to R2).
     *
     * Plain fields are stored inline in the manifest.
     */
    async upload(params: UploadParams, price: bigint): Promise<CommitResult> {
        const { records, schemaName, options } = params;

        const { schema, schemaId } = await this.resolveSchema(schemaName);

        for (const record of records) {
            this.validateRecord(record, schema);
            const entry = this.resolveRecord(record, schema);
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
     * Serialize all staged entries into a manifest, publish each entry
     * on-chain via the DataSourceRegistry, and record the manifest URI on-chain.
     */
    async commit(schemaId: Hex, price: bigint, overwrite: boolean): Promise<CommitResult> {
        const owner = this.requireAccount();

        if (this.pendingEntries.size === 0) {
            throw new Error("Nothing to commit. Stage at least one record.");
        }

        let entries = Array.from(this.pendingEntries.values());

        if (!overwrite) {
            const existingEntriesMap = await this.loadExistingEntries(owner, schemaId, entries);
            entries = [...Array.from(existingEntriesMap.values()), ...entries];
        }

        const manifest: Manifest = { version: 2, schemaId, entries };
        const manifestUri = await this.storage.put(manifest, { name: `manifest:${schemaId}` });

        for (const entry of entries) {
            await this.dataSourceRegistry.publish(manifestUri, schemaId, entry.name, price);
        }

        this.pendingEntries.clear();
        return { manifestUri, schemaId, owner, entryCount: entries.length };
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
     *
     * Handle fields are passed through directly
     * Plain fields are stored inline.
     */
    private resolveRecord(
        record: PublishRecord,
        schema: SchemaDefinition,
        // gadget: Gadget,
    ): ManifestEntry {
        const resolvedFields: Record<string, ResolvedField> = {};

        for (const [fieldName] of Object.entries(schema)) {
            const value = record.fields[fieldName];

            if (isHandleFieldInput(value)) {
                resolvedFields[fieldName] = {
                    "@type": "handle",
                    uri: value.uri,
                    // resourceId: gadget.resourceId,
                    // gadgetDescriptor: gadget.toDescriptor(),
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
        // handle fields are always valid regardless of schema @type —
        // the content is already stored, we trust the publisher supplied
        // the right URI for the right field
        if (isHandleFieldInput(value)) return;

        switch (fieldDef["@type"]) {
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
        }
    }

    private async loadExistingEntries(
        owner: Address,
        schemaId: Hex,
        pendingEntries: ManifestEntry[],
    ): Promise<Map<string, ManifestEntry>> {
        const existingMap = new Map<string, ManifestEntry>();
        const pendingNames = new Set(pendingEntries.map(e => e.name));

        const firstName = pendingEntries[0]?.name;
        if (!firstName) return existingMap;

        try {
            const ds = await this.dataSourceRegistry.get(owner, schemaId, firstName);
            if (!ds.manifestCid) return existingMap;

            const manifest = await this.storage.get<Manifest>(ds.manifestCid);
            for (const entry of manifest.entries) {
                if (!pendingNames.has(entry.name)) {
                    existingMap.set(entry.name, entry);
                }
            }

            try {
                await this.storage.delete(ds.manifestCid);
            } catch (e) {
                console.warn(`Failed to delete old manifest ${ds.manifestCid}:`, e);
            }
        } catch {
            // no existing manifest (first publish)
        }

        return existingMap;
    }
}

function isHandleFieldInput(value: FieldInput): value is HandleFieldInput {
    return (
        typeof value === "object" &&
        "@type" in value &&
        (value as unknown as Record<string, unknown>)["@type"] === "handle"
    );
}