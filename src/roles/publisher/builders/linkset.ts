import type { Hex } from "viem";
import type { ResolvedLinkset, LinkRecord } from "../../schema/types";
import type { LinksetManifest } from "../types";
import type { ManifestBuilder, ChunkDraft, ChunkRef, BuildContext, ResolvedSchemaShape } from "./types";
import { isEntityUri, isAlias } from "../../schema/identity";

export interface LinksetUploadInput {
    linksetName: string;
    links: LinkRecord[] | AsyncIterable<LinkRecord>;
    /** Records per merkle leaf. Default 1000. */
    chunkSize?: number;
}

/**
 * Publishes a linkset — asserted cross-edges — as a datasource
 * (docs/CROSS_PUBLISHER_LINKING_PLAN.md §5). Each link's endpoints are global
 * (Entity URI or namespaced alias) and may be **foreign**; the builder validates
 * every record (well-formed endpoints, allowed relation, sane confidence) and
 * chunks them into many merkle leaves under one root. Fusion of the asserted
 * `sameAs` edges into a view's union-find happens out-of-repo (quickbeam).
 */
export class LinksetBuilder implements ManifestBuilder<LinksetUploadInput, LinksetManifest> {
    readonly kind = "linkset";

    validate(schema: ResolvedSchemaShape, input: LinksetUploadInput): void {
        if (!isLinksetSchema(schema)) throw new Error("LinksetBuilder requires a linkset schema");
        if (input.chunkSize !== undefined && (!Number.isInteger(input.chunkSize) || input.chunkSize <= 0)) {
            throw new Error(`chunkSize must be a positive integer, got ${input.chunkSize.toString()}`);
        }
    }

    async *chunk(input: LinksetUploadInput, schema: ResolvedSchemaShape): AsyncIterable<ChunkDraft> {
        if (!isLinksetSchema(schema)) throw new Error("expected linkset schema");
        const chunkSize = input.chunkSize && input.chunkSize > 0 ? input.chunkSize : 1000;
        // Empty allowlist = any non-empty relation is accepted.
        const allowed = schema.rels.length > 0 ? new Set(schema.rels) : null;

        let buf: LinkRecord[] = [];
        let seq = 0;
        let count = 0;
        const flush = (): ChunkDraft => {
            const draft: ChunkDraft = { name: `linkset:${seq.toString()}`, data: buf, meta: { kind: "links", seq } };
            buf = []; seq++;
            return draft;
        };

        for await (const link of input.links) {
            validateLink(link, allowed);
            buf.push(normalizeLink(link));
            count++;
            if (buf.length >= chunkSize) yield flush();
        }
        if (buf.length > 0) yield flush();
        if (count === 0) throw new Error("linkset has no links");
    }

    compareChunks(a: ChunkRef, b: ChunkRef): number {
        const as = typeof a.meta?.seq === "number" ? a.meta.seq : 0;
        const bs = typeof b.meta?.seq === "number" ? b.meta.seq : 0;
        return as - bs;
    }

    assemble(ctx: BuildContext): LinksetManifest {
        const linkChunks = ctx.chunks.map((c, i) => ({ dataCid: c.cid, leaf: ctx.leaves[i], contentId: c.contentId }));
        if (linkChunks.length === 0) throw new Error("Missing link chunk during assembly");
        return { kind: "linkset", schemaId: ctx.schemaId, root: ctx.root, linkChunks, tree: ctx.layers };
    }
}

/** An endpoint must be a well-formed Entity URI or a namespaced alias. */
function isValidEndpoint(s: unknown): s is string {
    return typeof s === "string" && (isEntityUri(s) || isAlias(s));
}

function validateLink(link: LinkRecord, allowed: Set<string> | null): void {
    if (!isValidEndpoint(link.from)) {
        throw new Error(`link "from" is neither an Entity URI nor a namespaced alias: ${JSON.stringify(link.from)}`);
    }
    if (!isValidEndpoint(link.to)) {
        throw new Error(`link "to" is neither an Entity URI nor a namespaced alias: ${JSON.stringify(link.to)}`);
    }
    if (typeof link.rel !== "string" || link.rel.trim().length === 0) {
        throw new Error(`link missing a relation (rel): ${JSON.stringify(link)}`);
    }
    if (allowed && !allowed.has(link.rel)) {
        throw new Error(`relation "${link.rel}" not in this linkset's allowlist [${[...allowed].join(", ")}]`);
    }
    if (link.confidence !== undefined) {
        const c = link.confidence;
        if (typeof c !== "number" || Number.isNaN(c) || c < 0 || c > 1) {
            throw new Error(`link confidence must be a number in [0,1], got ${JSON.stringify(c)}`);
        }
    }
}

/** Keep only the canonical fields; drop undefined optionals for a stable shape. */
function normalizeLink(link: LinkRecord): LinkRecord {
    const out: LinkRecord = { from: link.from, rel: link.rel, to: link.to };
    if (link.confidence !== undefined) out.confidence = link.confidence;
    if (link.evidence !== undefined) out.evidence = link.evidence;
    return out;
}

function isLinksetSchema(schema: ResolvedSchemaShape): schema is ResolvedLinkset {
    return "rels" in schema && Array.isArray((schema as ResolvedLinkset).rels);
}
