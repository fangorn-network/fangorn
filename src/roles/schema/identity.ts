//
// Copyright (c) Fangorn LLC and contributors. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.
//

// give every entity a *global* name so foreign edges can reference it. Two name forms:
//
//   1. Entity URI      fangorn:<resourceId>/<localId>   — always exists, derived
//                      from the datasource (resourceId = keccak256(owner ‖
//                      schemaId ‖ keccak256(name)), see DataSourceRegistry).
//   2. Namespaced alias <namespace>:<value>             — e.g. isrc:GBAYE6800301,
//                      an externally-anchored key two publishers can join on.
//
// This module is pure string handling: no I/O, fully deterministic.

import type { Hex } from "viem";
import type { NodeIdentity } from "./types.js";

/** URI scheme that identifies a Fangorn-native Entity URI. e.g. fangorn://*/
export const FANGORN_SCHEME = "fangorn" as const;

/** Reserved node-field key: declares which field carries the node's canonical id. */
export const RESERVED_ID_KEY = "@id" as const;

/** Reserved relation: asserts two entities are the same equivalence class. */
export const RESERVED_SAMEAS_REL = "sameAs" as const;

/** A parsed Fangorn Entity URI. */
export interface ParsedEntityUri {
    resourceId: Hex;
    localId: string;
}

/** A parsed namespaced alias (`isrc:GBAYE6800301` → `{ isrc, GBAYE6800301 }`). */
export interface ParsedAlias {
    namespace: string;
    value: string;
}

// 0x followed by exactly 64 hex chars (a 32-byte keccak256 resourceId).
const RESOURCE_ID_RE = /^0x[0-9a-fA-F]{64}$/;
// lowercase, alphanumeric, must start with a letter.
const NAMESPACE_RE = /^[a-z][a-z0-9]*$/;

/** Build the canonical Entity URI for a node in a datasource. */
export function toEntityUri(resourceId: Hex, localId: string): string {
    if (!RESOURCE_ID_RE.test(resourceId)) {
        throw new Error(`invalid resourceId "${resourceId}" (expected 0x + 64 hex chars)`);
    }
    if (localId.length === 0) throw new Error("localId must be non-empty");
    return `${FANGORN_SCHEME}:${resourceId}/${localId}`;
}

/** Parse a `fangorn:<resourceId>/<localId>` URI. Throws if malformed. */
export function parseEntityUri(uri: string): ParsedEntityUri {
    const prefix = `${FANGORN_SCHEME}:`;
    if (!uri.startsWith(prefix)) throw new Error(`not a ${FANGORN_SCHEME} Entity URI: "${uri}"`);
    const body = uri.slice(prefix.length);
    // localId may itself contain "/", so split only on the first separator.
    const slash = body.indexOf("/");
    if (slash === -1) throw new Error(`Entity URI missing localId: "${uri}"`);
    const resourceId = body.slice(0, slash) as Hex;
    const localId = body.slice(slash + 1);
    if (!RESOURCE_ID_RE.test(resourceId)) throw new Error(`Entity URI has invalid resourceId: "${uri}"`);
    if (localId.length === 0) throw new Error(`Entity URI missing localId: "${uri}"`);
    return { resourceId, localId };
}

/** Non-throwing predicate: is `s` a well-formed Fangorn Entity URI? */
export function isEntityUri(s: string): boolean {
    try {
        parseEntityUri(s);
        return true;
    } catch {
        return false;
    }
}

/** Parse a `<namespace>:<value>` alias. Throws if malformed or reserved. */
export function parseAlias(s: string): ParsedAlias {
    const colon = s.indexOf(":");
    if (colon === -1) throw new Error(`alias missing "<namespace>:" prefix: "${s}"`);
    const namespace = s.slice(0, colon);
    const value = s.slice(colon + 1); // value may contain further colons
    if (namespace === FANGORN_SCHEME) {
        throw new Error(`"${FANGORN_SCHEME}" is the reserved Entity-URI scheme, not an alias namespace`);
    }
    if (!NAMESPACE_RE.test(namespace)) {
        throw new Error(`invalid alias namespace "${namespace}" (expected lowercase alphanumeric, leading letter)`);
    }
    if (value.length === 0) throw new Error(`alias "${s}" has an empty value`);
    return { namespace, value };
}

/** Non-throwing predicate: is `s` a well-formed namespaced alias (and not an Entity URI)? */
export function isAlias(s: string): boolean {
    try {
        parseAlias(s);
        return true;
    } catch {
        return false;
    }
}

// Coerce a node field value to the string form used in an id/alias, or null
// when the value is absent/empty (caller decides whether that's an error).
function scalarString(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") return value.length > 0 ? value : null;
    if (typeof value === "number") return String(value);
    throw new Error(`identity field value must be a string or number, got ${typeof value}`);
}

/**
 * Build the namespaced aliases a node exposes, from its identity declaration
 * and resolved fields. Fields that are absent/null/empty are skipped; the
 * result is sorted by namespace for deterministic ordering. Throws if a
 * declared namespace is malformed or a referenced field holds a non-scalar.
 */
export function extractAliases(fields: Record<string, unknown>, decl: NodeIdentity): string[] {
    const out: string[] = [];
    for (const namespace of Object.keys(decl.aliases ?? {}).sort()) {
        const field = (decl.aliases ?? {})[namespace];
        const value = scalarString(fields[field]);
        if (value === null) continue;
        const alias = `${namespace}:${value}`;
        parseAlias(alias); // validates the namespace; throws on a bad declaration
        out.push(alias);
    }
    return out;
}

/**
 * Resolve a node's localId: the value of the declared `@id` field, or the
 * node's own id when no `@id` is declared. Throws if `@id` is declared but the
 * field is absent or empty.
 */
export function resolveLocalId(nodeId: string, fields: Record<string, unknown>, decl: NodeIdentity): string {
    const idField = decl[RESERVED_ID_KEY];
    if (idField === undefined) return nodeId;
    const value = scalarString(fields[idField]);
    if (value === null) throw new Error(`@id field "${idField}" is absent or empty on node "${nodeId}"`);
    return value;
}
