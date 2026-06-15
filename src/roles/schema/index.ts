import { type Hex, type WalletClient } from "viem";
import { SchemaRegistry } from "../../registries/schema-registry";
import { MetadataStorage } from "../../providers/storage/types.js";
import { BundleInput, ResolvedBundle, SchemaBlob, SchemaDefinition, SchemaDoc, TypeDefinition } from "./types";
import { validate } from "./validate";

export * from './types';

// Register either a 'resolver' (a standard flat schema, optionally with a
// custom-type vocabulary) or a 'bundle' (the shape of how resolver schemas combine).
export type RegisterSchemaParams =
    | { kind?: "resolver"; name: string; definition: SchemaDefinition; types?: Record<string, TypeDefinition> }
    | { kind: "bundle"; name: string; bundle: BundleInput };

type RegisteredSchemaBase = {
    schemaId: Hex;
    schemaCid: string;
    name: string;
    owner: Hex;
};
export type RegisteredSchema =
    | (RegisteredSchemaBase & { kind: "resolver"; definition: SchemaDefinition; types?: Record<string, TypeDefinition> })
    | (RegisteredSchemaBase & { kind: "bundle"; bundle: ResolvedBundle });


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
            blob = { kind: "bundle", name: params.name, owner, createdAt, bundle };
        } else {
            blob = { kind: "resolver", name: params.name, owner, createdAt, definition: params.definition, types: params.types };
        }

        const schemaCid = await this.storage.put(blob, { name: `schema:${params.name}` });

        let schemaId: Hex;
        try {
            ({ schemaId } = await this.schemaRegistry.registerSchema(params.name, schemaCid));
        } catch (err) {
            if (!isSchemaAlreadyExists(err)) throw err;
            schemaId = await this.schemaRegistry.schemaId(params.name);
        }

        const base = { schemaId, schemaCid, name: params.name, owner };
        return blob.kind === "bundle"
            ? { kind: "bundle", ...base, bundle: blob.bundle }
            : { kind: "resolver", ...base, definition: blob.definition, types: blob.types };
    }

    async get(nameOrId: string): Promise<RegisteredSchema | undefined> {
        try {
            const schemaId = await this.schemaRegistry.schemaId(nameOrId as Hex);
            const record = await this.schemaRegistry.getSchema(nameOrId);
            if (!record.specCid) return undefined;

            const blob = await this.storage.get<SchemaBlob>(record.specCid);
            const base = { schemaId, schemaCid: record.specCid, name: blob.name, owner: blob.owner };

            if (blob.kind === "resolver") {
                return { kind: "resolver", ...base, definition: blob.definition, types: blob.types };
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

    validate(data: Record<string, unknown>, definition: SchemaDefinition | SchemaDoc): string[] {
        return validate(data, definition);
    }

    private requireAccount(): Hex {
        const address = this.walletClient.account?.address;
        if (!address) throw new Error("No account connected to wallet client");
        return address;
    }
}

function isSchemaAlreadyExists(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const data = (err as any)?.cause?.data ?? (err as any)?.data;
    return data?.errorName === "SchemaAlreadyExists";
}