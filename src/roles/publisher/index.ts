import { type Address, type Hex, type WalletClient } from "viem";
import { Gadget } from "../../modules/gadgets";
import { FieldDefinition, SchemaDefinition } from "../schema/types";
import { DataSourceRegistry } from "../../registries/datasource-registry";
import { PinningService, retrieveByCid } from "../../providers/storage";
import { EncryptionService } from "../../modules/encryption";
import {
    CommitResult,
    EncryptedFieldInput,
    FieldInput,
    Manifest,
    ManifestEntry,
    PublishRecord,
    ResolvedEncryptedField,
    ResolvedField,
    ResolvedPlainField,
    UploadParams,
} from "./types";
import { SettlementRegistry } from "../../registries/settlement-registry";
import { AppConfig } from "../../config";
import { SchemaRegistry } from "../../registries/schema-registry";
import { SettledGadget } from "../../modules/gadgets/settledGadget";

export * from './types';

export class PublisherRole {

    private pendingEntries = new Map<string, ManifestEntry>();
    private readonly schemaCache = new Map<string, Promise<{ schema: SchemaDefinition; schemaId: Hex }>>();

    constructor(
        private readonly dataSourceRegistry: DataSourceRegistry,
        private readonly schemaRegistry: SchemaRegistry,
        private readonly storage: PinningService,
        private readonly encryptionService: EncryptionService,
        private readonly walletClient: WalletClient,
        private readonly config: AppConfig,
    ) { }

    /**
     * Encrypt and upload schema-conformant data.
     *
     * Validates records against the schema, encrypts fields as required,
     * stages all resolved entries, then commits to IPFS and publishes on-chain.
     *
     * Each encrypted field within a record is stored as a separate IPFS object.
     * The manifest entry stores the handle (CID + gateway) alongside plain fields.
     * Consumers can read plain fields freely and only need to purchase and decrypt
     * for encrypted fields.
     */
    async upload(params: UploadParams, price: bigint): Promise<CommitResult> {
        const { records, schemaName, gateway, options } = params;

        const address = this.requireAccount();
        const { schema, schemaId } = await this.resolveSchema(schemaName);

        // default to settled gadget
        const gadgetFactory = (name: string) => {
            const resourceId = DataSourceRegistry.resourceIdLocal(
                address,
                schemaId,
                name
            );
            return new SettledGadget({
                resourceId,
                settlementRegistryAddress: this.config.settlementRegistryContractAddress,
                chainName: this.config.chainName,
            })
        }

        // we only need to validate new records 
        for (const record of records) {
            this.validateRecord(record, schema);
            const gadget = gadgetFactory(record.name);
            // process encrypted fields
            const entry = await this.resolveRecord(record, schema, gadget, gateway);
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
     * on-chain via the DataSourceRegistry (which calls into the
     * SettlementRegistry to create/update the Semaphore group), pin the
     * manifest to IPFS, and record the manifest CID on-chain.
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

        const manifest: Manifest = { version: 1, schemaId, entries };
        const manifestCid = await this.storage.store(manifest, {
            metadata: { name: `manifest:${schemaId}` },
        });

        // publish each entry individually
        // the DataSourceRegistry handles createResource (first publish) vs updatePrice (subsequent) internally
        for (const entry of entries) {
            await this.dataSourceRegistry.publish(manifestCid, schemaId, entry.name, price);
        }

        this.pendingEntries.clear();
        return { manifestCid, schemaId, owner, entryCount: entries.length };
    }

    async getManifest(schemaId: Hex, name: string): Promise<Manifest | undefined> {
        const owner = this.requireAccount();
        try {
            const ds = await this.dataSourceRegistry.get(owner, schemaId, name);
            if (!ds.manifestCid || ds.manifestCid === "") return undefined;
            return retrieveByCid<Manifest>(ds.manifestCid, this.config.ipfsGateway);
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

    // ── Internal ──────────────────────────────────────────────────────────────

    private requireAccount(): Address {
        const address = this.walletClient.account?.address;
        if (!address) throw new Error("No account connected to wallet client");
        return address;
    }

    /**
     * Resolve the schema definition and id by name, with in-memory caching.
     * Concurrent calls for the same name share a single in-flight promise.
     */
    private resolveSchema(name: string): Promise<{ schema: SchemaDefinition; schemaId: Hex }> {
        if (!this.schemaCache.has(name)) {
            const p = Promise.all([
                this.schemaRegistry.getSchema(name),
                this.schemaRegistry.schemaId(name),
            ])
                .then(async ([{ specCid }, schemaId]) => {
                    const registered = await retrieveByCid<{ definition: SchemaDefinition }>(
                        specCid,
                        this.config.ipfsGateway,
                    );
                    return { schema: registered.definition, schemaId };
                })
                .catch(err => {
                    this.schemaCache.delete(name);
                    throw err;
                });

            this.schemaCache.set(name, p);
        }
        return this.schemaCache.get(name)!;
    }

    /**
     * Resolve a PublishRecord into a ManifestEntry by processing each field
     * according to the schema definition:
     *   - plain fields are stored as-is
     *   - encrypted fields are encrypted, pinned to IPFS, and replaced
     *     with a handle + gadgetDescriptor
     */
    private async resolveRecord(
        record: PublishRecord,
        schema: SchemaDefinition,
        gadget: Gadget,
        gateway: string,
    ): Promise<ManifestEntry> {
        const resolvedFields: Record<string, ResolvedField> = {};

        for (const [fieldName, fieldDef] of Object.entries(schema)) {
            const value = record.fields[fieldName];

            if (fieldDef["@type"] === "encrypted") {
                const input = value as EncryptedFieldInput;
                const encrypted = await this.encryptionService.encrypt(
                    {
                        tag: `${record.name}:${fieldName}`,
                        data: input.data,
                        extension: input.extension ?? "",
                        fileType: input.fileType ?? "application/octet-stream",
                    },
                    gadget,
                );

                const cid = await this.storage.store(encrypted, {
                    metadata: { name: `${record.name}:${fieldName}` },
                });

                resolvedFields[fieldName] = {
                    "@type": "encrypted",
                    handle: { cid, gateway },
                    gadgetDescriptor: gadget.toDescriptor(),
                } satisfies ResolvedEncryptedField;
            } else {
                resolvedFields[fieldName] = value as ResolvedPlainField;
            }
        }

        return { name: record.name, fields: resolvedFields };
    }

    /**
     * Validate that a record's fields match the schema before touching IPFS.
     */
    private validateRecord(record: PublishRecord, schema: SchemaDefinition): void {
        const errors: string[] = [];

        for (const [fieldName, fieldDef] of Object.entries(schema)) {
            this.validateField(record.name, fieldName, fieldDef, record.fields[fieldName], errors);
        }

        for (const fieldName of Object.keys(record.fields)) {
            if (!(fieldName in schema)) {
                console.warn(
                    `Record "${record.name}": field "${fieldName}" is not in the schema and will be ignored`
                );
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
            case "encrypted":
                if (typeof value !== "object" || !("data" in value) || !(value.data instanceof Uint8Array))
                    errors.push(
                        `"${fieldName}" is encrypted — expected EncryptedFieldInput { data: Uint8Array }`
                    );
                break;
        }
    }

    /**
     * Load existing entries for merge behaviour, keyed by name.
     * Unpins the old manifest CID after loading.
     * Pending entries take precedence — existing entries with the same name
     * are overwritten.
     */
    private async loadExistingEntries(
        owner: Address,
        schemaId: Hex,
        pendingEntries: ManifestEntry[],
    ): Promise<Map<string, ManifestEntry>> {
        const existingMap = new Map<string, ManifestEntry>();
        const pendingNames = new Set(pendingEntries.map(e => e.name));

        // use the first pending entry's name to find the existing manifest —
        // all entries for an owner/schema share the same manifest CID
        const firstName = pendingEntries[0]?.name;
        if (!firstName) return existingMap;

        try {
            const ds = await this.dataSourceRegistry.get(owner, schemaId, firstName);
            if (!ds.manifestCid) return existingMap;

            const manifest = await retrieveByCid<Manifest>(ds.manifestCid, this.config.ipfsGateway);
            for (const entry of manifest.entries) {
                if (!pendingNames.has(entry.name)) {
                    existingMap.set(entry.name, entry);
                }
            }

            try {
                await this.storage.delete(ds.manifestCid);
            } catch (e) {
                console.warn(`Failed to unpin old manifest ${ds.manifestCid}:`, e);
            }
        } catch {
            // no existing manifest — first publish
        }

        return existingMap;
    }
}