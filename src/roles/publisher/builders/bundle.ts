import type { Hex } from "viem";
import type { SchemaDefinition, SchemaDoc, TypeDefinition, ResolvedBundle } from "../../schema/types";
import type { MetadataStorage } from "../../../providers/storage/types";
import type { SchemaRegistry } from "../../../registries/schema-registry";
import type { BundleManifest, BundleNode, FieldInput, PublishRecord, ResolvedField } from "../types";
import type { ManifestBuilder, ChunkDraft, ChunkRef, BuildContext, ResolvedSchemaShape } from "./types";
import { validateRecord, resolveRecord } from "./utils";

type Node = { id: string; type: string; fields: Record<string, FieldInput> };
type Edge = { rel: string; from: string; to: string };

export interface BundleUploadInput {
    bundleName: string;
    nodes: Node[] | AsyncIterable<Node>;
    edges?: Edge[] | AsyncIterable<Edge>;
    /** Entries per merkle leaf (nodes chunked per type, edges chunked across). Default 1000. */
    chunkSize?: number;
    /**
     * Cross-node graph validation: edge endpoints exist, declared relations,
     * cardinality, duplicate node ids. Per-record SCHEMA validation always runs.
     * Set false for very large STREAMED inputs — it skips the in-memory node-id
     * map (the only unbounded structure), keeping peak memory ~ one chunk. Default true.
     */
    validate?: boolean;
}

export class BundleBuilder implements ManifestBuilder<BundleUploadInput, BundleManifest> {
    readonly kind = "bundle";

    constructor(
        private readonly storage: MetadataStorage,
        private readonly schemaRegistry: SchemaRegistry,
    ) { }

    validate(schema: ResolvedSchemaShape, _input: BundleUploadInput): void {
        if (!isBundleSchema(schema)) throw new Error("BundleBuilder requires a bundle schema");
        // "has nodes" is enforced in chunk() — input may be a stream we can't pre-count.
    }

    /**
     * Stream nodes (chunked per type) then edges (chunked) into ~chunkSize-entry
     * leaves, so a 50M-edge bundle becomes many small leaves under ONE merkle root
     * — not one oversized chunk that blows V8's ~512MB `JSON.stringify` cap. With a
     * stream input + `validate:false`, peak memory is ~one chunk regardless of size.
     *
     * Merkle correctness:
     *  - Each chunk carries a monotonic `seq` (yield order). `compareChunks` orders
     *    by `seq`, so publish()'s sort restores yield order deterministically (a
     *    strict total order — no ties, so the tree is reproducible).
     *  - `assemble` maps each chunk to its leaf by SORTED POSITION (ctx.leaves[i] ↔
     *    ctx.chunks[i], since leaves = chunks.map(...) after the sort). This is correct
     *    regardless of upload-completion ordering or the creation-index in leaf hashes.
     */
    async *chunk(input: BundleUploadInput, schema: ResolvedSchemaShape): AsyncIterable<ChunkDraft> {
        const bundle = schema as ResolvedBundle;
        const chunkSize = input.chunkSize && input.chunkSize > 0 ? input.chunkSize : 1000;
        const doValidate = input.validate ?? true;

        const defByType = await this.resolveDefs(bundle);
        const declared = new Set(bundle.edges.map(e => `${e.rel}:${e.from}:${e.to}`));
        const constrained = bundle.edges.filter(s => (s.min ?? 0) > 0 || (s.max ?? null) !== null);

        // The lone unbounded structures — only allocated when validating, so a huge
        // streamed publish with validate:false stays memory-bounded.
        const nodeType = doValidate ? new Map<string, string>() : null;
        const seenIds = doValidate ? new Set<string>() : null;

        let seq = 0;
        let nodeChunkCount = 0;

        // ── nodes: per-type buffers, flushed at chunkSize ─────────────────────
        const buffers = new Map<string, BundleNode[]>();
        for await (const node of input.nodes) {
            if (!(node.type in bundle.nodes)) throw new Error(`node "${node.id}" has undeclared type "${node.type}"`);
            const def = defByType.get(node.type);
            if (!def) throw new Error(`Missing definition schema for type "${node.type}"`);
            if (seenIds) {
                if (seenIds.has(node.id)) throw new Error(`duplicate node id "${node.id}"`);
                seenIds.add(node.id);
            }
            nodeType?.set(node.id, node.type);

            const record: PublishRecord = { name: node.id, fields: node.fields };
            validateRecord(record, def); // per-record schema validation (always on)
            const resolved = resolveRecord(record, def);

            let buf = buffers.get(node.type);
            if (!buf) { buf = []; buffers.set(node.type, buf); }
            buf.push({ id: node.id, type: node.type, fields: resolved.fields as Record<string, ResolvedField> });
            if (buf.length >= chunkSize) {
                yield { name: `bundle-node:${node.type}:${seq.toString()}`, data: buf, meta: { kind: "node", type: node.type, seq } };
                seq++; nodeChunkCount++;
                buffers.set(node.type, []);
            }
        }
        for (const type of [...buffers.keys()].sort()) {
            const buf = buffers.get(type);
            if (buf && buf.length > 0) {
                yield { name: `bundle-node:${type}:${seq.toString()}`, data: buf, meta: { kind: "node", type, seq } };
                seq++; nodeChunkCount++;
            }
        }
        if (nodeChunkCount === 0) throw new Error("bundle has no nodes");

        // ── edges: single growing buffer, flushed at chunkSize ────────────────
        const counts = doValidate && constrained.length > 0 ? new Map<string, number>() : null;
        let edgeBuf: Edge[] = [];
        let edgeChunkCount = 0;
        for await (const e of (input.edges ?? [])) {
            if (doValidate && nodeType) {
                const ft = nodeType.get(e.from);
                const tt = nodeType.get(e.to);
                if (!ft) throw new Error(`edge "${e.rel}" from unknown node "${e.from}"`);
                if (!tt) throw new Error(`edge "${e.rel}" to unknown node "${e.to}"`);
                const key = `${e.rel}:${ft}:${tt}`;
                if (!declared.has(key)) throw new Error(`undeclared relation "${e.rel}" (${ft} → ${tt})`);
                if (counts) counts.set(`${e.from}\x00${key}`, (counts.get(`${e.from}\x00${key}`) ?? 0) + 1);
            }
            edgeBuf.push({ rel: e.rel, from: e.from, to: e.to });
            if (edgeBuf.length >= chunkSize) {
                yield { name: `bundle-edges:${seq.toString()}`, data: edgeBuf, meta: { kind: "edges", seq } };
                seq++; edgeChunkCount++; edgeBuf = [];
            }
        }
        if (edgeBuf.length > 0) {
            yield { name: `bundle-edges:${seq.toString()}`, data: edgeBuf, meta: { kind: "edges", seq } };
            seq++; edgeChunkCount++;
        }
        // Always emit at least one edge chunk so the manifest has an edge section.
        if (edgeChunkCount === 0) {
            yield { name: `bundle-edges:${seq.toString()}`, data: [] as Edge[], meta: { kind: "edges", seq } };
            seq++;
        }

        // ── cardinality (min/max), O(nodes + edges), only for constrained shapes ──
        if (doValidate && nodeType && counts) {
            const errors: string[] = [];
            for (const shape of constrained) {
                const min = shape.min ?? 0;
                const max = shape.max ?? null;
                const key = `${shape.rel}:${shape.from}:${shape.to}`;
                for (const [id, type] of nodeType) {
                    if (type !== shape.from) continue;
                    const count = counts.get(`${id}\x00${key}`) ?? 0;
                    if (count < min) errors.push(`node "${id}" has ${count.toString()} "${shape.rel}" edges, needs min ${min.toString()}`);
                    if (max !== null && count > max) errors.push(`node "${id}" has ${count.toString()} "${shape.rel}" edges, exceeds max ${max.toString()}`);
                }
            }
            if (errors.length) throw new Error("Bundle edge validation failed:\n" + errors.map(e => ` - ${e}`).join("\n"));
        }
    }

    compareChunks(a: ChunkRef, b: ChunkRef): number {
        // Total order = yield order via the monotonic seq. No ties → deterministic
        // sort → reproducible merkle tree.
        const as = typeof a.meta?.seq === "number" ? a.meta.seq : 0;
        const bs = typeof b.meta?.seq === "number" ? b.meta.seq : 0;
        return as - bs;
    }

    assemble(ctx: BuildContext): BundleManifest {
        // After publish()'s sort, ctx.chunks[i] and ctx.leaves[i] are position-aligned
        // (leaves = chunks.map(...)). Map by index i — robust to upload ordering.
        const nodeChunks: { type: string; dataCid: string; leaf: Hex }[] = [];
        const edgeChunks: { dataCid: string; leaf: Hex }[] = [];
        ctx.chunks.forEach((c, i) => {
            const leaf = ctx.leaves[i];
            if (c.meta?.kind === "edges") edgeChunks.push({ dataCid: c.cid, leaf });
            else nodeChunks.push({ type: typeof c.meta?.type === "string" ? c.meta.type : "", dataCid: c.cid, leaf });
        });
        if (edgeChunks.length === 0) throw new Error("Missing edge chunk during assembly");

        return { kind: "bundle", schemaId: ctx.schemaId, root: ctx.root, nodeChunks, edgeChunks, tree: ctx.layers };
    }

    /**
     * Resolve each bundle node type to its `SchemaDoc` ({ fields, types }) so
     * `chunk()` can validate/resolve records per type. Fetched once up front.
     */
    private async resolveDefs(bundle: ResolvedBundle): Promise<Map<string, SchemaDoc>> {
        const defByType = new Map<string, SchemaDoc>();
        await Promise.all(
            Object.entries(bundle.nodes).map(async ([type, schemaId]: [string, Hex]) => {
                const { specCid } = await this.schemaRegistry.getSchema(schemaId);
                const blob = await this.storage.get<{ definition?: SchemaDefinition; types?: Record<string, TypeDefinition> }>(specCid);
                if (!blob.definition) throw new Error(`node schema ${schemaId} is not a resolver schema`);
                defByType.set(type, { fields: blob.definition, types: blob.types });
            }),
        );
        return defByType;
    }
}

// check if something is a bundle or not
function isBundleSchema(schema: ResolvedSchemaShape): schema is ResolvedBundle {
    return "nodes" in schema && "edges" in schema;
}
