import type { Hex } from "viem";
import type { SchemaDoc, ResolvedBundle } from "../../schema/types";

export interface ChunkDraft {
    // storage object name passed to storage.put
    name: string;
    // arbitrary, serialized by storage layer
    data: unknown;
    // builder-defined, carried through to ChunkRef
    meta?: Record<string, unknown>;
}

export interface ChunkRef {
    index: bigint;
    cid: string;
    name: string;
    meta?: Record<string, unknown>;
}

export interface BuildContext {
    schemaId: Hex;
    chunks: ChunkRef[];
    leaves: Hex[];
    root: Hex;
    layers: Hex[][];
}

export interface BaseManifest {
    kind: string;
    schemaId: Hex;
    root: Hex;
    tree: Hex[][];
}

export type ResolvedSchemaShape = SchemaDoc | ResolvedBundle;

// Commit-time context known before chunking begins (owner + schema + dataset
// name → the datasource resourceId). Builders that stamp global identity onto
// records (e.g. BundleBuilder's Entity URIs) need it; others ignore it.
export interface CommitInfo {
    resourceId: Hex;
}

export interface ManifestBuilder<TInput, TManifest extends BaseManifest> {
    readonly kind: string;
    validate(schema: ResolvedSchemaShape, input: TInput): void | Promise<void>;
    chunk(input: TInput, schema: ResolvedSchemaShape, commit?: CommitInfo): AsyncIterable<ChunkDraft>;
    compareChunks(a: ChunkRef, b: ChunkRef): number;
    assemble(context: BuildContext, input: TInput, schema: ResolvedSchemaShape): TManifest;
}
