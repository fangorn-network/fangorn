import { describe, it, expect } from "vitest";
import type { Hex } from "viem";
import { ViewBuilder, type ViewUploadInput } from "./view.js";
import type { ResolvedView } from "../../schema/types.js";
import type { ChunkDraft, BuildContext } from "./types.js";

const A = ("0x" + "a".repeat(64)) as Hex;
const B = ("0x" + "b".repeat(64)) as Hex;
const L = ("0x" + "c".repeat(64)) as Hex;
const SCHEMA_ID = ("0x" + "d".repeat(64)) as Hex;
const RID = ("0x" + "e".repeat(64)) as Hex;
const S1 = ("0x" + "1".repeat(64)) as Hex;
const S2 = ("0x" + "2".repeat(64)) as Hex;

const view: ResolvedView = { sources: [A, B], linksets: [L], trust: { minConfidence: 0.9 }, sourceSchemas: [S1, S2] };
const input: ViewUploadInput = { viewName: "creative.view.v1" };

async function collect(schema: ResolvedView): Promise<ChunkDraft[]> {
    const builder = new ViewBuilder();
    const drafts: ChunkDraft[] = [];
    for await (const d of builder.chunk(input, schema, { resourceId: RID })) drafts.push(d);
    return drafts;
}

describe("ViewBuilder — Phase 1 composed view", () => {
    it("validates a view schema and rejects a non-view shape", () => {
        const builder = new ViewBuilder();
        expect(() => { builder.validate(view, input); }).not.toThrow();
        expect(() => { builder.validate({ fields: {} }, input); }).toThrow(/view/i);
    });

    it("emits the resolved view declaration as a single chunk", async () => {
        const drafts = await collect(view);
        expect(drafts).toHaveLength(1);
        expect(drafts[0].data).toEqual({ sources: [A, B], linksets: [L], trust: { minConfidence: 0.9 }, sourceSchemas: [S1, S2] });
    });

    it("assembles a view manifest that pins sources, linksets, and trust", async () => {
        const builder = new ViewBuilder();
        const ctx: BuildContext = {
            schemaId: SCHEMA_ID,
            chunks: [{ index: 0n, cid: "cid:view", name: "view", meta: {} }],
            leaves: ["0xleaf" as Hex],
            root: "0xroot" as Hex,
            layers: [["0xleaf" as Hex]],
        };
        const manifest = builder.assemble(ctx, input, view);
        expect(manifest).toEqual({
            kind: "view",
            schemaId: SCHEMA_ID,
            root: "0xroot",
            sources: [A, B],
            linksets: [L],
            trust: { minConfidence: 0.9 },
            sourceSchemas: [S1, S2],
            viewChunk: { dataCid: "cid:view", leaf: "0xleaf" },
            tree: [["0xleaf"]],
        });
    });
});
