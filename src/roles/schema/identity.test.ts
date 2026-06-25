import { describe, it, expect } from "vitest";
import {
    toEntityUri,
    parseEntityUri,
    isEntityUri,
    parseAlias,
    isAlias,
    extractAliases,
    resolveLocalId,
    FANGORN_SCHEME,
    RESERVED_ID_KEY,
    RESERVED_SAMEAS_REL,
} from "./identity.js";
import type { NodeIdentity } from "./types.js";
import type { Hex } from "viem";

// A real 32-byte resourceId (as produced by DataSourceRegistry.resourceId).
const RID = "0x1234567890123456789012345678901234567890123456789012345678901234" as Hex;

describe("identity — Entity URI", () => {
    it("constructs fangorn:<resourceId>/<localId>", () => {
        expect(toEntityUri(RID, "t-42")).toBe(`fangorn:${RID}/t-42`);
    });

    it("round-trips construct → parse", () => {
        const uri = toEntityUri(RID, "t-42");
        expect(parseEntityUri(uri)).toEqual({ resourceId: RID, localId: "t-42" });
    });

    it("preserves localIds containing colons (e.g. review parent:index)", () => {
        const uri = toEntityUri(RID, "ChIJSc8N:0");
        expect(parseEntityUri(uri)).toEqual({ resourceId: RID, localId: "ChIJSc8N:0" });
    });

    it("splits only on the first slash so localIds may contain slashes", () => {
        const uri = `fangorn:${RID}/a/b/c`;
        expect(parseEntityUri(uri)).toEqual({ resourceId: RID, localId: "a/b/c" });
    });

    it("rejects an empty localId", () => {
        expect(() => toEntityUri(RID, "")).toThrow();
    });

    it("rejects a malformed resourceId", () => {
        expect(() => toEntityUri("0xdeadbeef" as Hex, "t-42")).toThrow();
    });

    it("parseEntityUri rejects a non-fangorn scheme", () => {
        expect(() => parseEntityUri(`isrc:${RID}/t-42`)).toThrow();
    });

    it("parseEntityUri rejects a missing localId", () => {
        expect(() => parseEntityUri(`fangorn:${RID}`)).toThrow();
        expect(() => parseEntityUri(`fangorn:${RID}/`)).toThrow();
    });

    it("isEntityUri discriminates URIs from aliases", () => {
        expect(isEntityUri(toEntityUri(RID, "t-42"))).toBe(true);
        expect(isEntityUri("isrc:GBAYE6800301")).toBe(false);
        expect(isEntityUri("t-42")).toBe(false);
    });

    it("exposes the scheme constant", () => {
        expect(FANGORN_SCHEME).toBe("fangorn");
    });
});

describe("identity — namespaced aliases", () => {
    it("parses <namespace>:<value>", () => {
        expect(parseAlias("isrc:GBAYE6800301")).toEqual({ namespace: "isrc", value: "GBAYE6800301" });
    });

    it("splits on the first colon so values may contain colons", () => {
        expect(parseAlias("gplace:ChIJSc8N:0")).toEqual({ namespace: "gplace", value: "ChIJSc8N:0" });
    });

    it("rejects an empty value", () => {
        expect(() => parseAlias("isrc:")).toThrow();
    });

    it("rejects a missing namespace separator", () => {
        expect(() => parseAlias("GBAYE6800301")).toThrow();
    });

    it("rejects a namespace that is not lowercase-alphanumeric", () => {
        expect(() => parseAlias("ISRC:x")).toThrow();
        expect(() => parseAlias("1isrc:x")).toThrow();
        expect(() => parseAlias("is rc:x")).toThrow();
    });

    it("rejects the reserved fangorn namespace as an alias", () => {
        expect(() => parseAlias(`fangorn:${RID}/t-42`)).toThrow();
    });

    it("isAlias discriminates aliases from URIs and bare ids", () => {
        expect(isAlias("isrc:GBAYE6800301")).toBe(true);
        expect(isAlias(toEntityUri(RID, "t-42"))).toBe(false);
        expect(isAlias("t-42")).toBe(false);
    });
});

describe("identity — extractAliases (node decl → namespaced aliases)", () => {
    it("builds aliases from declared namespace→field mappings", () => {
        const decl: NodeIdentity = { aliases: { isrc: "isrcCode" } };
        expect(extractAliases({ isrcCode: "GBAYE6800301" }, decl)).toEqual(["isrc:GBAYE6800301"]);
    });

    it("returns aliases in deterministic (namespace-sorted) order", () => {
        const decl: NodeIdentity = { aliases: { mbid: "mb", isrc: "is", gplace: "gp" } };
        expect(extractAliases({ is: "I", mb: "M", gp: "G" }, decl)).toEqual([
            "gplace:G",
            "isrc:I",
            "mbid:M",
        ]);
    });

    it("coerces numeric field values to strings", () => {
        const decl: NodeIdentity = { aliases: { upc: "code" } };
        expect(extractAliases({ code: 12345 }, decl)).toEqual(["upc:12345"]);
    });

    it("skips fields that are absent, null, or empty", () => {
        const decl: NodeIdentity = { aliases: { isrc: "isrcCode", mbid: "mbidCode" } };
        expect(extractAliases({ isrcCode: "X", mbidCode: null }, decl)).toEqual(["isrc:X"]);
        expect(extractAliases({ isrcCode: "" }, decl)).toEqual([]);
    });

    it("returns [] when no aliases are declared", () => {
        expect(extractAliases({ a: 1 }, {})).toEqual([]);
    });

    it("throws on an invalid declared namespace", () => {
        const decl: NodeIdentity = { aliases: { ISRC: "f" } };
        expect(() => extractAliases({ f: "x" }, decl)).toThrow();
    });

    it("throws on a non-scalar field value", () => {
        const decl: NodeIdentity = { aliases: { isrc: "f" } };
        expect(() => extractAliases({ f: { nested: true } }, decl)).toThrow();
    });
});

describe("identity — resolveLocalId", () => {
    it("defaults to the node id when @id is not declared", () => {
        expect(resolveLocalId("t-42", {}, {})).toBe("t-42");
    });

    it("promotes the @id field's value when declared", () => {
        const decl: NodeIdentity = { "@id": "placeId" };
        expect(resolveLocalId("row-7", { placeId: "ChIJSc8N" }, decl)).toBe("ChIJSc8N");
    });

    it("coerces a numeric @id field to a string", () => {
        expect(resolveLocalId("row-7", { n: 99 }, { "@id": "n" })).toBe("99");
    });

    it("throws when the declared @id field is absent or empty", () => {
        expect(() => resolveLocalId("row-7", {}, { "@id": "placeId" })).toThrow();
        expect(() => resolveLocalId("row-7", { placeId: "" }, { "@id": "placeId" })).toThrow();
    });
});

describe("identity — reserved keys", () => {
    it("reserves @id for the canonical-id field declaration", () => {
        expect(RESERVED_ID_KEY).toBe("@id");
    });

    it("reserves sameAs as the equivalence relation", () => {
        expect(RESERVED_SAMEAS_REL).toBe("sameAs");
    });
});
