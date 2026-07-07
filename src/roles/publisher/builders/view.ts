import type { ResolvedView } from "../../schema/types";
import type { ViewManifest } from "../types";
import type { ManifestBuilder, ChunkDraft, ChunkRef, BuildContext, ResolvedSchemaShape } from "./types";

/**
 * Author-facing input. A view's *content* is its resolved declaration (which
 * already lives in the registered schema blob), so there is nothing to stream —
 * the name is here only for parity with the other builders / nicer chunk names.
 */
export interface ViewUploadInput {
    viewName: string;
}

/**
 * Publishes a composed view as a datasource (docs/CROSS_PUBLISHER_LINKING_PLAN.md
 * §4). A view is "just another datasource" — it reuses the entire publish/commit
 * pipeline. Its only content is the declaration `{ sources, linksets, trust }`,
 * emitted as a single merkle leaf so the committed root attests exactly which
 * inputs a downstream indexer (quickbeam) is told to fuse. No identity stamping,
 * no node/edge chunking — fusion itself happens out-of-repo.
 */
export class ViewBuilder implements ManifestBuilder<ViewUploadInput, ViewManifest> {
    readonly kind = "view";

    validate(schema: ResolvedSchemaShape, _input: ViewUploadInput): void {
        if (!isViewSchema(schema)) throw new Error("ViewBuilder requires a view schema");
    }

    // A view is a single, small declaration — one chunk, one leaf.
    async *chunk(_input: ViewUploadInput, schema: ResolvedSchemaShape): AsyncIterable<ChunkDraft> {
        if (!isViewSchema(schema)) throw new Error("expected view schema");
        const { sources, linksets, trust, sourceSchemas } = schema;
        yield { name: "view", data: { sources, linksets, trust, sourceSchemas }, meta: { kind: "view" } };
    }

    compareChunks(_a: ChunkRef, _b: ChunkRef): number {
        // Single chunk — order is irrelevant.
        return 0;
    }

    assemble(ctx: BuildContext, _input: ViewUploadInput, schema: ResolvedSchemaShape): ViewManifest {
        if (!isViewSchema(schema)) throw new Error("expected view schema");
        const chunk = ctx.chunks[0];
        if (!chunk) throw new Error("view produced no chunk during assembly");
        return {
            kind: "view",
            schemaId: ctx.schemaId,
            root: ctx.root,
            sources: schema.sources,
            linksets: schema.linksets,
            trust: schema.trust,
            sourceSchemas: schema.sourceSchemas,
            viewChunk: { dataCid: chunk.cid, leaf: ctx.leaves[0] },
            tree: ctx.layers,
        };
    }
}

function isViewSchema(schema: ResolvedSchemaShape): schema is ResolvedView {
    return "sources" in schema;
}
