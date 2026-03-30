import { type Address, type Hex, type WalletClient } from "viem";
import { Gadget } from "../../modules/gadgets";
import { FieldDefinition, SchemaDefinition } from "../schema/types";
import { DataSourceRegistry } from "../../registries/datasource-registry";
import { WritableStorage } from "../../providers/storage";
import { EncryptionService } from "../../modules/encryption";
import { CommitResult, EncryptedFieldInput, FieldInput, Manifest, ManifestEntry, PublishRecord, ResolvedEncryptedField, ResolvedField, ResolvedPlainField, UploadParams } from "./types";
import { SettlementRegistry } from "../../registries/settlement-registry";
import { makeSettledGadgetFactory, SettledGadget } from "../../modules/gadgets/settledGadget";
import { AppConfig } from "../../config";

export * from './types';

export class PublisherRole {
    private pendingEntries = new Map<string, ManifestEntry>();

    constructor(
        private readonly dataSourceRegistry: DataSourceRegistry,
        private readonly settlementRegistry: SettlementRegistry,
        private readonly storage: WritableStorage<unknown>,
        private readonly encryptionService: EncryptionService,
        private readonly walletClient: WalletClient,
        private readonly config: AppConfig,
    ) { }

    /**
     * Encrypt and Upload data with Fangorn
     * Validate records against the schema, encrypt encrypted
     * fields, stage all resolved entries, then commit to IPFS + on-chain.
     *
     * Each encrypted field within a record is stored as a separate IPFS object
     * (the ciphertext). The manifest entry stores the handle (CID + gateway)
     * alongside the plain fields. Consumers can read plain fields freely and
     * only need to purchase + decrypt for encrypted fields.
     */
    async upload(
        params: UploadParams,
        price: bigint
    ): Promise<CommitResult> {
        const { records, schema, schemaId, gateway, options } = params;

        const address = this.requireAccount();
        // default to settled gadget
        const gadgetFactory = (tag: string) => {
            const resourceId = SettlementRegistry.deriveResourceId(
                address,
                schemaId,
                tag
            );
            return new SettledGadget({
                resourceId,
                settlementRegistryAddress: this.config.settlementRegistryContractAddress,
                chainName: this.config.chainName,
            })
        }

        // we only need to validate new records 
        for (const record of records) {
            // ensure schema validity
            this.validateRecord(record, schema);
            // instantiate the gadget
            // get resourceId
            const resourceId = SettlementRegistry.deriveResourceId(
                address,
                schemaId,
                record.tag
            );
            console.log('using resource Id' + resourceId)
            const gadget = await gadgetFactory(record.tag);
            // process encrypted fields
            const entry = await this.resolveRecord(record, schema, gadget, gateway);
            this.pendingEntries.set(record.tag, entry);
        }

        return this.commit(schemaId, price, options?.overwrite ?? false);
    }

    stage(entry: ManifestEntry): void {
        this.pendingEntries.set(entry.tag, entry);
    }

    remove(tag: string): boolean {
        return this.pendingEntries.delete(tag);
    }

    getPending(): ManifestEntry[] {
        return Array.from(this.pendingEntries.values());
    }

    clearPending(): void {
        this.pendingEntries.clear();
    }

    /**
     * Serialize all staged entries into a manifest, create SettlementRegistry
     * resources for each entry, pin the manifest to IPFS, and publish on-chain.
     * 
     * @param schemaId: The unique id of the schema
     * @param price: The USDC price required to register with the sempaphore group
     * @param overwrite: If true, overwrite manifest data, else append (default: false)
     * 
     */
    async commit(schemaId: Hex, price: bigint, overwrite: boolean): Promise<CommitResult> {
        const owner = this.requireAccount();

        if (this.pendingEntries.size === 0) {
            throw new Error("Nothing to commit. Stage at least one record.");
        }

        let entries = Array.from(this.pendingEntries.values());

        for (const entry of entries) {
            const resourceId = SettlementRegistry.deriveResourceId(owner, schemaId, entry.tag);
            try {
                await this.settlementRegistry.createResource(resourceId, price);
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                if (!msg.includes("ResourceAlreadyExists")
                    && !msg.includes("AlreadyExists"))
                    console.warn("Failed to create the resource: already exists!");
            }
        }

        // enrich the entries with exist manifest items
        if (!overwrite) {
            const existingEntriesMap = await this.loadExistingManifest(owner, schemaId);
            const vals = existingEntriesMap.values();
            entries = [...Array.from(vals), ...entries]
        }

        const manifest: Manifest = { version: 1, schemaId, entries };
        const manifestCid = await this.storage.store(manifest, {
            metadata: { name: `manifest:${schemaId}` },
        });

        await this.dataSourceRegistry.publishManifest(manifestCid, schemaId);
        this.pendingEntries.clear();

        return { manifestCid, schemaId, owner, entryCount: entries.length };
    }

    async getManifest(schemaId: Hex): Promise<Manifest | undefined> {
        const owner = this.requireAccount();
        try {
            const ds = await this.dataSourceRegistry.getManifest(owner, schemaId);
            if (!ds.manifestCid || ds.manifestCid === "") return undefined;
            return (await this.storage.retrieve(ds.manifestCid)) as Manifest;
        } catch {
            return undefined;
        }
    }

    async getEntry(schemaId: Hex, tag: string): Promise<ManifestEntry> {
        const manifest = await this.getManifest(schemaId);
        if (!manifest) throw new Error(`No manifest found for schemaId ${schemaId}`);
        const entry = manifest.entries.find((e) => e.tag === tag);
        if (!entry) throw new Error(`Entry not found: "${tag}"`);
        return entry;
    }

    private requireAccount(): Address {
        const address = this.walletClient.account?.address;
        if (!address) throw new Error("No account connected to wallet client");
        return address;
    }

    /**
     * Resolve a PublishRecord into a ManifestEntry by processing each field
     * according to the schema definition:
     *   - plain fields are stored as-is
     *   - encrypted fields are AES+Lit encrypted, pinned to IPFS, and replaced
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
                        tag: `${record.tag}:${fieldName}`,
                        data: input.data,
                        extension: input.extension ?? "",
                        fileType: input.fileType ?? "application/octet-stream",
                    },
                    gadget,
                );

                const cid = await this.storage.store(encrypted, {
                    metadata: { name: `${record.tag}:${fieldName}` },
                });

                const gadgetDescriptor = gadget.toDescriptor();

                resolvedFields[fieldName] = {
                    "@type": "encrypted",
                    handle: { cid, gateway },
                    gadgetDescriptor,
                } satisfies ResolvedEncryptedField;
            } else {
                // plain -> no change
                resolvedFields[fieldName] = value as ResolvedPlainField;
            }
        }

        return { tag: record.tag, fields: resolvedFields };
    }

    /**
     * Validate that a record's fields match the schema before touching IPFS.
     * Catches type mismatches and missing required fields early.
     */
    private validateRecord(record: PublishRecord, schema: SchemaDefinition): void {
        const errors: string[] = [];

        for (const [fieldName, fieldDef] of Object.entries(schema)) {
            const value = record.fields[fieldName];

            // if (value === undefined || value === null) {
            //     errors.push(`Record "${record.tag}": missing required field "${fieldName}"`);
            //     continue;
            // }

            this.validateField(record.tag, fieldName, fieldDef, value, errors);
        }

        // Warn on extra fields not in schema (not an error — schema is open)
        for (const fieldName of Object.keys(record.fields)) {
            if (!(fieldName in schema)) {
                console.warn(
                    `Record "${record.tag}": field "${fieldName}" is not in the schema and will be ignored`,
                );
            }
        }

        if (errors.length > 0) {
            throw new Error(
                `Validation failed for record "${record.tag}":\n` +
                errors.map((e) => `  • ${e}`).join("\n"),
            );
        }
    }

    private validateField(
        tag: string,
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
                if (
                    typeof value !== "object" || !("data" in value) || !((value).data instanceof Uint8Array)
                ) {
                    errors.push(
                        `"${fieldName}" is encrypted — expected EncryptedFieldInput { data: Uint8Array }`,
                    );
                }
                break;
        }
    }

    /**
     * Load the existing manifest into pending entries for merge behaviour.
     * Unpins the old manifest CID
     */
    private async loadExistingManifest(
        owner: Address,
        schemaId: Hex
    ): Promise<Map<string, ManifestEntry>> {
        const entries = new Map<string, ManifestEntry>();

        try {
            const ds = await this.dataSourceRegistry.getManifest(owner, schemaId);
            if (!ds.manifestCid) return entries;

            const manifest = (await this.storage.retrieve(ds.manifestCid)) as Manifest;
            for (const entry of manifest.entries) {
                entries.set(entry.tag, entry);
            }

            try {
                await this.storage.delete(ds.manifestCid);
            } catch (e) {
                console.warn(`Failed to unpin old manifest ${ds.manifestCid}:`, e);
            }
        } catch {
            // No existing manifest (first publish)
        }
        return entries;
    }
}