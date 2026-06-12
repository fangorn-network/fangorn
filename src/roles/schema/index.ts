import { type Hex, type WalletClient } from "viem";
import { SchemaRegistry } from "../../registries/schema-registry";
import { MetadataStorage } from "../../providers/storage/types.js";
import { BundleInput, PlainField, ResolvedBundle, SchemaBlobV1, SchemaDefinition } from "./types";

export * from './types';

// Register either a 'resolver' (a standard flat schema)
// or a 'bundle' (the shape of how resolver schemas combine).
export type RegisterSchemaParams =
    | { kind?: "resolver"; name: string; definition: SchemaDefinition }
    | { kind: "bundle"; name: string; bundle: BundleInput };

type RegisteredSchemaBase = {
    schemaId: Hex;
    schemaCid: string;
    name: string;
    owner: Hex;
};
export type RegisteredSchema =
    | (RegisteredSchemaBase & { kind: "resolver"; definition: SchemaDefinition })
    | (RegisteredSchemaBase & { kind: "bundle"; bundle: ResolvedBundle });

// Persisted blob (v2, discriminated). v1 blobs (no `kind`) are read as resolvers.
type PersistedBlobBase = { version: 2; name: string; owner: Hex; createdAt: string };
type ResolverBlob = PersistedBlobBase & { kind: "resolver"; definition: SchemaDefinition };
type BundleBlob = PersistedBlobBase & { kind: "bundle"; bundle: ResolvedBundle };
type SchemaBlob = ResolverBlob | BundleBlob;

export class SchemaRole {
    constructor(
        private readonly schemaRegistry: SchemaRegistry,
        private readonly storage: MetadataStorage,
        private readonly walletClient: WalletClient,
    ) { }

    async register(params: RegisterSchemaParams): Promise<RegisteredSchema> {
        const owner = this.requireAccount();
        const createdAt = new Date().toISOString();

        let blob: SchemaBlob;
        if (params.kind === "bundle") {
            const bundle = await this.resolveBundle(params.bundle);
            blob = { version: 2, kind: "bundle", name: params.name, owner, createdAt, bundle };
        } else {
            blob = { version: 2, kind: "resolver", name: params.name, owner, createdAt, definition: params.definition };
        }

        const schemaCid = await this.storage.put(blob, { name: `schema:${params.name}` });
        const { schemaId } = await this.schemaRegistry.registerSchema(params.name, schemaCid);

        const base = { schemaId, schemaCid, name: params.name, owner };
        return blob.kind === "bundle"
            ? { kind: "bundle", ...base, bundle: blob.bundle }
            : { kind: "resolver", ...base, definition: blob.definition };
    }

    async get(nameOrId: string): Promise<RegisteredSchema | undefined> {
        try {
            const schemaId = await this.schemaRegistry.schemaId(nameOrId as Hex);
            const record = await this.schemaRegistry.getSchema(nameOrId);
            if (!record.specCid) return undefined;

            const blob = await this.storage.get<SchemaBlob | SchemaBlobV1>(record.specCid);
            const base = { schemaId, schemaCid: record.specCid, name: blob.name, owner: blob.owner };

            // v1 (no `kind`) and v2 resolver both carry `definition`
            if (!("kind" in blob) || blob.kind === "resolver") {
                return { kind: "resolver", ...base, definition: (blob as ResolverBlob | SchemaBlobV1).definition };
            }
            return { kind: "bundle", ...base, bundle: blob.bundle };
        } catch (e) {
            console.error(e);
            return undefined;
        }
    }

    /** Resolve node refs → registered resolver schemaIds and enforce edge closure. */
    private async resolveBundle(input: BundleInput): Promise<ResolvedBundle> {
        const errors: string[] = [];
        if (Object.keys(input.nodes).length === 0) errors.push("bundle declares no node types");

        const nodes: Record<string, Hex> = {};
        await Promise.all(
            Object.entries(input.nodes).map(async ([typeName, ref]) => {
                const existing = await this.get(ref);
                if (!existing) errors.push(`node "${typeName}" → unknown schema "${ref}"`);
                else if (existing.kind !== "resolver") errors.push(`node "${typeName}" → "${ref}" is a bundle; nodes must be resolver schemas`);
                else nodes[typeName] = existing.schemaId;
            }),
        );

        input.edges.forEach((e, i) => {
            if (!e.rel) errors.push(`edge[${i}] missing rel`);
            if (!(e.from in input.nodes)) errors.push(`edge[${i}] "${e.rel}" from undeclared type "${e.from}"`);
            if (!(e.to in input.nodes)) errors.push(`edge[${i}] "${e.rel}" to undeclared type "${e.to}"`);
            const min = e.min ?? 0;
            const max = e.max ?? null;
            if (min < 0) errors.push(`edge[${i}] "${e.rel}" min < 0`);
            if (max !== null && max < min) errors.push(`edge[${i}] "${e.rel}" max(${max}) < min(${min})`);
        });

        if (errors.length) throw new Error("Invalid bundle shape:\n" + errors.map(e => ` - ${e}`).join("\n"));
        return { nodes, edges: input.edges };
    }

    validate(data: Record<string, unknown>, definition: SchemaDefinition): string[] {
        const errors: string[] = [];
        for (const [field, fieldDef] of Object.entries(definition)) {
            const value = data[field];
            if (value === undefined || value === null) {
                errors.push(`Missing required field: "${field}"`);
                continue;
            }
            switch (fieldDef["@type"]) {
                case "string":
                    if (typeof value !== "string") errors.push(`Field "${field}" must be a string, got ${typeof value}`);
                    break;
                case "number":
                    if (typeof value !== "number") errors.push(`Field "${field}" must be a number, got ${typeof value}`);
                    break;
                case "boolean":
                    if (typeof value !== "boolean") errors.push(`Field "${field}" must be a boolean, got ${typeof value}`);
                    break;
                case "bytes":
                    if (!(value instanceof Uint8Array) && !ArrayBuffer.isView(value)) errors.push(`Field "${field}" must be bytes (Uint8Array)`);
                    break;
                case "handle": {
                    const asObj = value as Record<string, unknown>;
                    if (typeof asObj.uri !== "string") errors.push(`Field "${field}" is a handle — expected { uri: string }`);
                    break;
                }
                case "array": {
                    if (!Array.isArray(value)) {
                        errors.push(`Field "${field}" must be an array, got ${typeof value}`);
                        break;
                    }
                    const items: PlainField = fieldDef.items as PlainField;
                    value.forEach((item: unknown, i) =>
                        errors.push(...this.validate(
                            { [`${field}[${i.toString()}]`]: item },
                            { [`${field}[${i.toString()}]`]: items },
                        )),
                    );
                    break;
                }
            }
        }
        return errors;
    }

    private requireAccount(): Hex {
        const address = this.walletClient.account?.address;
        if (!address) throw new Error("No account connected to wallet client");
        return address;
    }
}