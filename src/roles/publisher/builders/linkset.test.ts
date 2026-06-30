import { describe, it, expect } from "vitest";
import type { Hex } from "viem";
import { LinksetBuilder, type LinksetUploadInput } from "./linkset.js";
import type { ResolvedLinkset, LinkRecord } from "../../schema/types.js";
import type { ChunkDraft, BuildContext } from "./types.js";

const RID_A = ("0x" + "a".repeat(64)) as Hex;
const RID_B = ("0x" + "b".repeat(64)) as Hex;
const SCHEMA_ID = ("0x" + "d".repeat(64)) as Hex;

// A foreign sameAs: a Place in datasource A asserted equal to an event venue in B.
const URI_A = `fangorn:${RID_A}/ChIJplace`;
const URI_B = `fangorn:${RID_B}/evt-77`;

const anyRels: ResolvedLinkset = { rels: [] };

async function collect(input: LinksetUploadInput, schema: ResolvedLinkset): Promise<ChunkDraft[]> {
    const builder = new LinksetBuilder();
    const drafts: ChunkDraft[] = [];
    for await (const d of builder.chunk(input, schema)) drafts.push(d);
    return drafts;
}

describe("LinksetBuilder — Phase 2 asserted cross-edges", () => {
    it("validates and chunks links with foreign Entity-URI endpoints", async () => {
        const links: LinkRecord[] = [
            { from: URI_A, rel: "sameAs", to: URI_B, confidence: 0.93, evidence: { reason: "geo+name" } },
        ];
        const drafts = await collect({ linksetName: "l", links }, anyRels);
        expect(drafts).toHaveLength(1);
        expect((drafts[0].data as LinkRecord[])[0]).toEqual({
            from: URI_A, rel: "sameAs", to: URI_B, confidence: 0.93, evidence: { reason: "geo+name" },
        });
    });

    it("accepts namespaced-alias endpoints (the externally-anchored join key)", async () => {
        const links: LinkRecord[] = [{ from: "isrc:USRC17607839", rel: "sameAs", to: URI_B }];
        const drafts = await collect({ linksetName: "l", links }, anyRels);
        expect((drafts[0].data as LinkRecord[])[0]).toEqual({ from: "isrc:USRC17607839", rel: "sameAs", to: URI_B });
    });

    it("rejects an endpoint that is neither an Entity URI nor a namespaced alias", async () => {
        const links: LinkRecord[] = [{ from: "just-a-local-id", rel: "sameAs", to: URI_B }];
        await expect(collect({ linksetName: "l", links }, anyRels)).rejects.toThrow(/neither an Entity URI nor a namespaced alias/i);
    });

    it("rejects a relation outside the schema's allowlist", async () => {
        const links: LinkRecord[] = [{ from: URI_A, rel: "rivalOf", to: URI_B }];
        await expect(collect({ linksetName: "l", links }, { rels: ["sameAs"] })).rejects.toThrow(/not in this linkset's allowlist/i);
    });

    it("rejects an out-of-range confidence", async () => {
        const links: LinkRecord[] = [{ from: URI_A, rel: "sameAs", to: URI_B, confidence: 1.5 }];
        await expect(collect({ linksetName: "l", links }, anyRels)).rejects.toThrow(/confidence must be a number in \[0,1\]/i);
    });

    it("rejects a missing relation", async () => {
        const links = [{ from: URI_A, rel: "", to: URI_B }] as LinkRecord[];
        await expect(collect({ linksetName: "l", links }, anyRels)).rejects.toThrow(/missing a relation/i);
    });

    it("throws when the linkset has no links", async () => {
        await expect(collect({ linksetName: "l", links: [] }, anyRels)).rejects.toThrow(/no links/i);
    });

    it("assembles a linkset manifest pinning each chunk leaf", async () => {
        const builder = new LinksetBuilder();
        const ctx: BuildContext = {
            schemaId: SCHEMA_ID,
            chunks: [{ index: 0n, cid: "cid:links", name: "linkset:0", meta: { seq: 0 } }],
            leaves: ["0xleaf" as Hex],
            root: "0xroot" as Hex,
            layers: [["0xleaf" as Hex]],
        };
        expect(builder.assemble(ctx)).toEqual({
            kind: "linkset",
            schemaId: SCHEMA_ID,
            root: "0xroot",
            linkChunks: [{ dataCid: "cid:links", leaf: "0xleaf" }],
            tree: [["0xleaf"]],
        });
    });
});
