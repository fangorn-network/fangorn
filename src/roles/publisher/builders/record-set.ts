import type { ManifestBuilder, ChunkDraft, ChunkRef, BuildContext, ResolvedSchemaShape } from "./types";
import type { SchemaDefinition } from "../../schema/types";
import type { Manifest, PublishRecord } from "../types";
import { resolveRecord, validateRecord } from "./utils";

export interface RecordSetInput {
    records: PublishRecord[] | AsyncIterable<PublishRecord>;
    chunkSize?: number;
}

export class RecordSetBuilder implements ManifestBuilder<RecordSetInput, Manifest> {
    readonly kind = "record-set";

    validate(schema: ResolvedSchemaShape, _input: RecordSetInput): void {
        if (!isRecordSchema(schema)) {
            throw new Error("RecordSetBuilder requires a resolver schema, not a bundle");
        }
    }

    async *chunk(input: RecordSetInput, schema: ResolvedSchemaShape): AsyncIterable<ChunkDraft> {
        if (!isRecordSchema(schema)) throw new Error("expected resolver schema");
        const chunkSize = input.chunkSize ?? 1000;
        let buffer: ReturnType<typeof resolveRecord>[] = [];
        let chunkIdx = 0;

        const flush = (): ChunkDraft => {
            const draft: ChunkDraft = { name: `chunk:${chunkIdx}`, data: buffer };
            buffer = [];
            chunkIdx++;
            return draft;
        };

        const iter: AsyncIterable<PublishRecord> = isAsyncIterable(input.records)
            ? input.records
            : toAsyncIterable(input.records);

        for await (const record of iter) {
            validateRecord(record, schema);
            buffer.push(resolveRecord(record, schema));
            if (buffer.length >= chunkSize) yield flush();
        }
        if (buffer.length > 0) yield flush();
    }

    compareChunks(a: ChunkRef, b: ChunkRef): number {
        return a.cid.localeCompare(b.cid);
    }

    assemble(ctx: BuildContext, _input: RecordSetInput, _schema: ResolvedSchemaShape): Manifest {
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

function isRecordSchema(schema: ResolvedSchemaShape): schema is SchemaDefinition {
    return !("nodes" in schema && "edges" in schema);
}

function isAsyncIterable<T>(val: unknown): val is AsyncIterable<T> {
    return val !== null && typeof val === "object" && Symbol.asyncIterator in (val as object);
}

async function* toAsyncIterable<T>(arr: T[]): AsyncIterable<T> {
    for (const item of arr) yield item;
}
