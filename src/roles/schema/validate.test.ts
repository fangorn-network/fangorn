import { describe, it, expect } from "vitest";
import { validate } from "./validate.js";
import type { SchemaDoc, SchemaDefinition } from "./types.js";

describe("validate — built-in types (back-compat with flat SchemaDefinition)", () => {
    const flat: SchemaDefinition = {
        title: { "@type": "string" },
        count: { "@type": "number" },
        active: { "@type": "boolean" },
    };

    it("accepts a valid flat record", () => {
        expect(validate({ title: "x", count: 1, active: true }, flat)).toEqual([]);
    });

    it("flags type mismatches with a path-prefixed message", () => {
        const errs = validate({ title: 1, count: 1, active: true }, flat);
        expect(errs).toEqual([expect.stringContaining("title")]);
    });

    it("flags missing required fields", () => {
        const errs = validate({ title: "x", count: 1 }, flat);
        expect(errs).toEqual([expect.stringContaining("active")]);
    });

    it("allows nullable fields to be absent", () => {
        const schema: SchemaDefinition = { note: { "@type": "string | null" } };
        expect(validate({}, schema)).toEqual([]);
    });
});

describe("validate — constraint primitives", () => {
    it("regex", () => {
        const s: SchemaDefinition = { id: { "@type": "string", constraints: [{ kind: "regex", pattern: "^[0-9]+$" }] } };
        expect(validate({ id: "123" }, s)).toEqual([]);
        expect(validate({ id: "12a" }, s)).toEqual([expect.stringContaining("must match")]);
    });

    it("enum", () => {
        const s: SchemaDefinition = { c: { "@type": "string", constraints: [{ kind: "enum", values: ["A", "B"] }] } };
        expect(validate({ c: "A" }, s)).toEqual([]);
        expect(validate({ c: "Z" }, s)).toEqual([expect.stringContaining("must be one of")]);
    });

    it("range (inclusive + exclusive)", () => {
        const s: SchemaDefinition = { n: { "@type": "number", constraints: [{ kind: "range", min: 0, max: 10 }] } };
        expect(validate({ n: 0 }, s)).toEqual([]);
        expect(validate({ n: 10 }, s)).toEqual([]);
        expect(validate({ n: 11 }, s)).toEqual([expect.stringContaining("<= 10")]);

        const ex: SchemaDefinition = { n: { "@type": "number", constraints: [{ kind: "range", min: 0, exclusive: true }] } };
        expect(validate({ n: 0 }, ex)).toEqual([expect.stringContaining("> 0")]);
    });

    it("length (string and array)", () => {
        const s: SchemaDefinition = { t: { "@type": "string", constraints: [{ kind: "length", min: 1, max: 3 }] } };
        expect(validate({ t: "ab" }, s)).toEqual([]);
        expect(validate({ t: "" }, s)).toEqual([expect.stringContaining(">= 1")]);
        expect(validate({ t: "abcd" }, s)).toEqual([expect.stringContaining("<= 3")]);
    });
});

describe("validate — custom types", () => {
    const schema: SchemaDoc = {
        types: {
            payment: {
                shape: {
                    amount: { "@type": "string", constraints: [{ kind: "regex", pattern: "^[0-9]+$" }] },
                    currency: { "@type": "string", constraints: [{ kind: "enum", values: ["USDC", "USDT", "DAI"] }] },
                },
            },
        },
        fields: {
            title: { "@type": "string", constraints: [{ kind: "length", min: 1, max: 200 }] },
            artist: { "@type": "string" },
            price: { "@type": "payment" },
        },
    };

    it("accepts a valid record", () => {
        expect(validate({
            title: "Atom Heart Mother",
            artist: "Pink Floyd",
            price: { amount: "5000000", currency: "USDC" },
        }, schema)).toEqual([]);
    });

    it("rejects a bad nested field with a dotted path", () => {
        expect(validate({
            title: "Atom Heart Mother",
            artist: "Pink Floyd",
            price: { amount: "5.5", currency: "USDC" },
        }, schema)).toEqual([expect.stringContaining("price.amount")]);
    });

    it("rejects a nested enum violation", () => {
        expect(validate({
            title: "X",
            artist: "Y",
            price: { amount: "100", currency: "EUR" },
        }, schema)).toEqual([expect.stringContaining("price.currency")]);
    });

    it("rejects a too-long top-level field", () => {
        expect(validate({
            title: "A".repeat(300),
            artist: "Y",
            price: { amount: "100", currency: "USDC" },
        }, schema)).toEqual([expect.stringContaining("title")]);
    });

    it("errors on an unknown @type", () => {
        const bad: SchemaDoc = { fields: { foo: { "@type": "nonexistent" } } };
        expect(validate({ foo: "bar" }, bad)).toEqual([expect.stringContaining("unknown @type")]);
    });
});
