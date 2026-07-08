import { describe, it, expect } from "vitest";
import { conformFields } from "./bundle-source.js";
import type { SchemaDefinition } from "../roles/schema/types.js";

// conformFields is the field-shaping logic extracted from publish_bundle.ts and
// now shared with `fangorn commit --bundle`. These lock its coercion behavior so
// the CLI and the legacy script can't silently diverge.
describe("conformFields", () => {
    const def: SchemaDefinition = {
        name: { "@type": "string" },
        count: { "@type": "number" },
        active: { "@type": "boolean" },
        tags: { "@type": "array" },
        meta: { "@type": "object" },
        note: { "@type": "string | null" },
    } as unknown as SchemaDefinition;

    it("keeps well-typed values and only emits declared fields", () => {
        const out = conformFields(
            { name: "a", count: 3, active: true, tags: [1], meta: { x: 1 }, note: "hi", extra: "dropped" },
            def,
        );
        expect(out).toEqual({ name: "a", count: 3, active: true, tags: [1], meta: { x: 1 }, note: "hi" });
        expect(out).not.toHaveProperty("extra");
    });

    it("coerces stringy numbers/booleans and stringifies non-strings", () => {
        const out = conformFields({ name: 42, count: "7", active: "true", tags: [], meta: {}, note: null }, def);
        expect(out.name).toBe("42");
        expect(out.count).toBe(7);
        expect(out.active).toBe(true);
    });

    it("fills non-nullable missing fields with typed defaults, nullable with null", () => {
        const out = conformFields({}, def);
        expect(out).toEqual({ name: "", count: 0, active: false, tags: [], meta: {}, note: null });
    });

    it("falls back to a non-null default when a non-nullable number is unparseable", () => {
        const out = conformFields({ count: "not-a-number" }, def);
        expect(out.count).toBe(0);
    });
});
