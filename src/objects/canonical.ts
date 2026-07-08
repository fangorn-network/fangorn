/**
 * Canonical JSON serialization for content-addressed objects.
 *
 * A commit's CID must be a deterministic function of its logical contents —
 * the *same* commit built in TypeScript (SDK/CLI) and Python (quickbeam) has to
 * hash to the same bytes, or the two sides can't agree on object identity. Plain
 * `JSON.stringify` preserves insertion order, which is fragile across languages
 * and refactors. So object bytes go through this canonicalizer instead:
 *
 *   - object keys sorted lexicographically, recursively
 *   - no insignificant whitespace
 *   - `undefined`-valued keys dropped (so optional fields never perturb the hash)
 *   - `Uint8Array` encoded exactly as the storage layer's `serialize` does
 *     (`{ __type: "Uint8Array", data: <base64> }`), so a canonical string round-
 *     trips through `deserialize` unchanged.
 *
 * The result is a plain string. The storage layer's `serialize()` passes strings
 * through untouched, so handing it a canonical string means the bytes IPFS hashes
 * are exactly the ones we produced here.
 */
export function canonicalize(value: unknown): string {
    return encode(value);
}

function encode(value: unknown): string {
    if (value === null) return "null";

    if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new Error("cannot canonicalize non-finite number");
        return JSON.stringify(value);
    }
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "bigint") throw new Error("cannot canonicalize bigint; convert to string first");

    if (value instanceof Uint8Array) {
        return encode({ __type: "Uint8Array", data: Buffer.from(value).toString("base64") });
    }

    if (Array.isArray(value)) {
        return `[${value.map(v => encode(v === undefined ? null : v)).join(",")}]`;
    }

    if (typeof value === "object") {
        const obj = value as Record<string, unknown>;
        const keys = Object.keys(obj)
            .filter(k => obj[k] !== undefined)
            .sort();
        const body = keys.map(k => `${JSON.stringify(k)}:${encode(obj[k])}`).join(",");
        return `{${body}}`;
    }

    // functions, symbols, undefined at the top level
    throw new Error(`cannot canonicalize value of type ${typeof value}`);
}
