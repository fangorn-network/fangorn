import { describe, it, expect } from "vitest";
import type { Hex } from "viem";
import { BundleBuilder, type BundleUploadInput } from "./bundle.js";
import type { MetadataStorage } from "../../../providers/storage/types.js";
import type { SchemaRegistry } from "../../../registries/schema-registry";
import type { ResolvedBundle } from "../../schema/types.js";
import type { BundleNode } from "../types.js";
import type { ChunkDraft } from "./types.js";

// Schema ids for the two node types in the test bundle.
const BUSINESS_SCHEMA = "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;
const REVIEW_SCHEMA = "0x2222222222222222222222222222222222222222222222222222222222222222" as Hex;
// The committing datasource's resourceId (what Entity URIs are prefixed with).
const RID = "0x3333333333333333333333333333333333333333333333333333333333333333" as Hex;

// Business declares identity: localId comes from `placeId`, which is also a
// gplace: alias. Review declares no identity.
const SCHEMA_DOCS: Record<string, unknown> = {
    [BUSINESS_SCHEMA]: {
        definition: { title: { "@type": "string" }, placeId: { "@type": "string" } },
        identity: { "@id": "placeId", aliases: { gplace: "placeId" } },
    },
    [REVIEW_SCHEMA]: {
        definition: { body: { "@type": "string" } },
    },
};

// Minimal fakes — the builder only calls getSchema() + storage.get().
const fakeRegistry = {
    getSchema: (id: string) => Promise.resolve({ specCid: `cid:${id}`, name: id, agentId: "", owner: RID }),
} as unknown as SchemaRegistry;

const fakeStorage = {
    get: <T>(cid: string): Promise<T> => {
        const schemaId = cid.replace("cid:", "");
        return Promise.resolve(SCHEMA_DOCS[schemaId] as T);
    },
} as unknown as MetadataStorage;

const bundleSchema: ResolvedBundle = {
    nodes: { Business: BUSINESS_SCHEMA, Review: REVIEW_SCHEMA },
    edges: [{ rel: "hasReview", from: "Business", to: "Review" }],
};

async function collectNodes(input: BundleUploadInput, resourceId: Hex): Promise<BundleNode[]> {
    const builder = new BundleBuilder(fakeStorage, fakeRegistry);
    const nodes: BundleNode[] = [];
    for await (const draft of builder.chunk(input, bundleSchema, { resourceId }) as AsyncIterable<ChunkDraft>) {
        if (draft.meta?.kind === "node") nodes.push(...(draft.data as BundleNode[]));
    }
    return nodes;
}

describe("BundleBuilder — Phase 0 identity emission", () => {
    const input: BundleUploadInput = {
        bundleName: "places",
        nodes: [
            { id: "row-1", type: "Business", fields: { title: "Marina Bar", placeId: "ChIJabc" } },
            { id: "rev-1", type: "Review", fields: { body: "great" } },
        ],
        edges: [{ rel: "hasReview", from: "row-1", to: "rev-1" }],
    };

    it("promotes the @id field into the Entity URI localId and emits the alias", async () => {
        const nodes = await collectNodes(input, RID);
        const business = nodes.find(n => n.type === "Business");
        expect(business?.entityUri).toBe(`fangorn:${RID}/ChIJabc`);
        expect(business?.aliases).toEqual(["gplace:ChIJabc"]);
    });

    it("falls back to the raw node id and empty aliases when no identity is declared", async () => {
        const nodes = await collectNodes(input, RID);
        const review = nodes.find(n => n.type === "Review");
        expect(review?.entityUri).toBe(`fangorn:${RID}/rev-1`);
        expect(review?.aliases).toEqual([]);
    });

    it("keeps the raw node id intact alongside the Entity URI", async () => {
        const nodes = await collectNodes(input, RID);
        expect(nodes.find(n => n.type === "Business")?.id).toBe("row-1");
    });
});
