import type { Hex } from "viem";
import type { SchemaDefinition, SchemaDoc, TypeDefinition, ResolvedBundle } from "../../schema/types";
import type { MetadataStorage } from "../../../providers/storage/types";
import type { SchemaRegistry } from "../../../registries/schema-registry";
import type { BundleManifest, BundleNode, FieldInput, PublishRecord } from "../types";
import type { ManifestBuilder, ChunkDraft, ChunkRef, BuildContext, ResolvedSchemaShape } from "./types";
import { validateRecord, resolveRecord } from "./utils";

export interface BundleUploadInput {
    bundleName: string;
    nodes: { id: string; type: string; fields: Record<string, FieldInput> }[];
    edges?: { rel: string; from: string; to: string }[];
}

export class BundleBuilder implements ManifestBuilder<BundleUploadInput, BundleManifest> {
    readonly kind = "bundle";

    constructor(
        private readonly storage: MetadataStorage,
        private readonly schemaRegistry: SchemaRegistry,
    ) { }

    validate(schema: ResolvedSchemaShape, input: BundleUploadInput): void {
        if (!isBundleSchema(schema)) throw new Error("BundleBuilder requires a bundle schema");
        if (input.nodes.length === 0) throw new Error("bundle has no nodes");
    }

    // Yields node chunks in alphabetical type order then the edge chunk last.
    // This matches compareChunks, so creation-order indices equal sorted-position
    // indices — preserving identical leaf hashes to the legacy commitBundleTree.
    async *chunk(input: BundleUploadInput, schema: ResolvedSchemaShape): AsyncIterable<ChunkDraft> {
        const bundle = schema as ResolvedBundle;
        const { nodeType, byType } = await this.resolveNodes(bundle, input.nodes);
        validateBundleEdges(bundle, input.edges ?? [], nodeType);

        for (const type of [...byType.keys()].sort()) {
            const data = byType.get(type);
            if (!data) continue; // FIX: Replaced non-null assertion with structural fallback

            yield {
                name: `bundle-node:${type}`,
                data,
                meta: { kind: "node", type },
            };
        }
        yield {
            name: "bundle-edges",
            data: input.edges ?? [],
            meta: { kind: "edges" },
        };
    }

    compareChunks(a: ChunkRef, b: ChunkRef): number {
        const aIsEdge = a.meta?.kind === "edges";
        const bIsEdge = b.meta?.kind === "edges";
        if (aIsEdge && !bIsEdge) return 1;
        if (!aIsEdge && bIsEdge) return -1;

        // FIX: Extract type safe string values to satisfy no-base-to-string
        const aType = typeof a.meta?.type === "string" ? a.meta.type : "";
        const bType = typeof b.meta?.type === "string" ? b.meta.type : "";
        return aType.localeCompare(bType);
    }

    assemble(ctx: BuildContext): BundleManifest {
        const nodeChunks = ctx.chunks
            .filter(c => c.meta?.kind === "node")
            .map((c) => ({ // FIX: Removed unused `_i` parameter
                type: (c.meta?.type ?? "") as string, // FIX: Replaced `!` with a fallback
                dataCid: c.cid,
                leaf: ctx.leaves[Number(c.index)],
            }));

        const edgeChunk = ctx.chunks.find(c => c.meta?.kind === "edges");
        if (!edgeChunk) throw new Error("Missing edge chunk during assembly"); // FIX: Safe runtime verification instead of `!`

        return {
            kind: "bundle",
            schemaId: ctx.schemaId,
            root: ctx.root,
            nodeChunks,
            edgeChunk: {
                dataCid: edgeChunk.cid,
                leaf: ctx.leaves[Number(edgeChunk.index)],
            },
            tree: ctx.layers,
        };
    }

    private async resolveNodes(
        bundle: ResolvedBundle,
        nodes: BundleUploadInput["nodes"],
    ): Promise<{ nodeType: Map<string, string>; byType: Map<string, BundleNode[]> }> {
        const defByType = new Map<string, SchemaDoc>();
        await Promise.all(
            Object.entries(bundle.nodes).map(async ([type, schemaId]: [string, Hex]) => {
                const { specCid } = await this.schemaRegistry.getSchema(schemaId);
                const blob = await this.storage.get<{ definition?: SchemaDefinition; types?: Record<string, TypeDefinition> }>(specCid);
                if (!blob.definition) throw new Error(`node schema ${schemaId} is not a resolver schema`);
                defByType.set(type, { fields: blob.definition, types: blob.types });
            }),
        );

        const nodeType = new Map<string, string>();
        const seen = new Set<string>();
        const byType = new Map<string, BundleNode[]>();

        for (const node of nodes) {
            if (!(node.type in bundle.nodes)) throw new Error(`node "${node.id}" has undeclared type "${node.type}"`);
            if (seen.has(node.id)) throw new Error(`duplicate node id "${node.id}"`);
            seen.add(node.id);
            nodeType.set(node.id, node.type);

            const def = defByType.get(node.type);
            if (!def) throw new Error(`Missing definition schema for type "${node.type}"`); // FIX: Safe runtime check instead of `!`

            const record: PublishRecord = { name: node.id, fields: node.fields };
            validateRecord(record, def);
            const resolved = resolveRecord(record, def);
            const list = byType.get(node.type) ?? [];
            list.push({ id: node.id, type: node.type, fields: resolved.fields });
            byType.set(node.type, list);
        }

        return { nodeType, byType };
    }
}

// ── private helpers ───────────────────────────────────────────────────────────

function isBundleSchema(schema: ResolvedSchemaShape): schema is ResolvedBundle {
    return "nodes" in schema && "edges" in schema;
}

function validateBundleEdges(
    bundle: ResolvedBundle,
    edges: { rel: string; from: string; to: string }[],
    nodeType: Map<string, string>,
): void {
    const errors: string[] = [];
    const declared = new Set(bundle.edges.map(e => `${e.rel}:${e.from}:${e.to}`));

    edges.forEach((edge, i) => {
        const ft = nodeType.get(edge.from);
        const tt = nodeType.get(edge.to);
        const indexStr = i.toString(); // FIX: Extracted to satisfy template restrictions safely

        if (!ft) return errors.push(`edge[${indexStr}] "${edge.rel}" from unknown node "${edge.from}"`);
        if (!tt) return errors.push(`edge[${indexStr}] "${edge.rel}" to unknown node "${edge.to}"`);
        if (!declared.has(`${edge.rel}:${ft}:${tt}`))
            errors.push(`edge[${indexStr}] undeclared relation "${edge.rel}" (${ft} → ${tt})`);
    });

    for (const shape of bundle.edges) {
        const min = shape.min ?? 0;
        const max = shape.max ?? null;
        for (const [id, type] of nodeType) {
            if (type !== shape.from) continue;
            const count = edges.filter(
                e => e.rel === shape.rel && e.from === id && nodeType.get(e.to) === shape.to,
            ).length;

            const countStr = count.toString(); // FIX: Stringified numbers for templates
            const minStr = min.toString();
            const maxStr = max !== null ? max.toString() : "";

            if (count < min) errors.push(`node "${id}" has ${countStr} "${shape.rel}" edges, needs min ${minStr}`);
            if (max !== null && count > max) errors.push(`node "${id}" has ${countStr} "${shape.rel}" edges, exceeds max ${maxStr}`);
        }
    }

    if (errors.length) throw new Error("Bundle edge validation failed:\n" + errors.map(e => ` - ${e}`).join("\n"));
}