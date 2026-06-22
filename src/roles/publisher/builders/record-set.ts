import type { ManifestBuilder, ChunkDraft, ChunkRef, BuildContext, ResolvedSchemaShape } from "./types";
import type { SchemaDoc } from "../../schema/types";
import type { Manifest, PublishRecord } from "../types";
import { resolveRecord, validateRecord } from "./utils";

export interface RecordSetInput {
    records: PublishRecord[] | AsyncIterable<PublishRecord>;
    chunkSize?: number;
}

export class RecordSetBuilder implements ManifestBuilder<RecordSetInput, Manifest> {
    readonly kind = "record-set";

    validate(schema: ResolvedSchemaShape, input: RecordSetInput): void {
        if (!isRecordSchema(schema)) {
            throw new Error("RecordSetBuilder requires a resolver schema, not a bundle");
        }
        if (input.chunkSize !== undefined && (!Number.isInteger(input.chunkSize) || input.chunkSize <= 0)) {
            throw new Error(`chunkSize must be a positive integer, got ${input.chunkSize.toString()}`);
        }
    }

    async *chunk(input: RecordSetInput, schema: ResolvedSchemaShape): AsyncIterable<ChunkDraft> {
        if (!isRecordSchema(schema)) throw new Error("expected resolver schema");
        const chunkSize = input.chunkSize ?? 1000;
        let buffer: ReturnType<typeof resolveRecord>[] = [];
        let chunkIdx = 0;

        const flush = (): ChunkDraft => {
            const draft: ChunkDraft = { name: `chunk:${chunkIdx.toString()}`, data: buffer };
            buffer = [];
            chunkIdx++;
            return draft;
        };

        // `for await` consumes both arrays (sync iterable) and async iterables.
        for await (const record of input.records) {
            validateRecord(record, schema);
            buffer.push(resolveRecord(record, schema));
            if (buffer.length >= chunkSize) yield flush();
        }
        if (buffer.length > 0) yield flush();
    }

    compareChunks(a: ChunkRef, b: ChunkRef): number {
        return a.cid.localeCompare(b.cid);
    }

    // builds a manifest from the build context
    assemble(ctx: BuildContext): Manifest {
        return {
            kind: "record-set",
            schemaId: ctx.schemaId,
            root: ctx.root,
            entries: ctx.chunks.map((chunk, i) => ({
                name: chunk.name,
                fields: {
                    dataCid: chunk.cid,
                    leaf: ctx.leaves[i],
                },
            })),
            tree: ctx.layers,
        };
    }
}

function isRecordSchema(schema: ResolvedSchemaShape): schema is SchemaDoc {
    return "fields" in schema;
}
