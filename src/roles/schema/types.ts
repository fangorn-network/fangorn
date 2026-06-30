//
// Copyright (c) Fangorn LLC and contributors. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.
//

import { type Hex } from "viem";

// there are two 'kind' of schemas
// the resolver type refers to 'raw' schemas that need to be resolved (e.g. a well-defined schema def)
// while bundle refers to a BundleInput
export type SchemaKind = "resolver" | "bundle" | "view" | "linkset";

// A schema is simply a set of KV-pairs
export type SchemaDefinition = Record<string, FieldDefinition>;

// STANDARD SCHEMA TYPES

// allowed scalar types passed to the resolver
export type ScalarType = "string" | "number" | "boolean" | "bytes";

// allows for a field in the schema to be null
export type NullableType =
    | `${ScalarType} | null`
    | "array | null"
    | "object | null";

// each field in the schema 
export type FieldType = ScalarType | "array" | "object" | NullableType;

// a plain field identified by as "@type"
// e.g. {"type": "string"}, {"type": "object"}
export type PlainField =
    | { "@type": ScalarType | NullableType }
    | { "@type": "array" | "array | null"; items: FieldDefinition }
    | { "@type": "object" | "object | null"; items: Record<string, FieldDefinition> };

// Represents an encrypted field in a schema
export interface EncryptedField {
    "@type": "encrypted";
    gadget: string;
    handle?: {
        cid: string;
        gateway: string;
    };
}

// A handle field represents data that lives externally
export interface HandleField {
    "@type": "handle";
}

// CONSTRAINT PRIMITIVES
//
// A small, fixed vocabulary of value-level checks that schema authors compose
// onto fields and custom types. Adding a new `kind` is an SDK release; composing
// the existing kinds into a new custom type is zero code.
export type Constraint =
    | { kind: "regex"; pattern: string }
    | { kind: "enum"; values: (string | number | boolean)[] }
    | { kind: "range"; min?: number; max?: number; exclusive?: boolean }
    | { kind: "length"; min?: number; max?: number }
    | { kind: "ref"; type: string };

// A schema-author-declared custom type: a named shape of fields, optionally
// guarded by constraints applied to the whole value.
export interface TypeDefinition {
    shape: Record<string, FieldDefinition>;
    constraints?: Constraint[];
}

export interface FieldDefinition {
    "@type": string;
    "@description"?: string;
    constraints?: Constraint[];
    items?: FieldDefinition | Record<string, FieldDefinition>;
}

// Cross-publisher identity (docs/CROSS_PUBLISHER_LINKING.md, Phase 0).
// Declares how a node type exposes *global* identity so foreign edges can
// reference its entities and so two datasources can join on a shared key.
export interface NodeIdentity {
    // Field whose value supplies the node's localId. Defaults to the node id
    // itself when omitted. Lets a publisher promote an existing field (e.g. a
    // Google Place ID) to the canonical local key. Reserved key: "@id".
    "@id"?: string;
    // Maps an alias namespace (e.g. "isrc") to the field carrying its value.
    // The join contract is the namespace, not the field name: A may store the
    // value in `isrc`, B in `isrcCode`, and they still join on `isrc:`.
    aliases?: Record<string, string>;
}

// A schema document that pairs the flat field map with a custom-type vocabulary.
// `validate` accepts either this or a bare SchemaDefinition (back-compat); the
// latter is treated as `{ fields }` with no custom types.
export interface SchemaDoc {
    types?: Record<string, TypeDefinition>;
    fields: SchemaDefinition;
    // Optional Phase-0 identity declaration for this node type.
    identity?: NodeIdentity;
}

// bundle "shape" types inspired by SHACL

// represents an edge between two nodes in a graph
// this tethers data *across* schemas
export interface EdgeShape {
    // e.g. "performed_by"
    rel: string;                 
    // local node-type name, a key in `nodes`
    from: string;                
    // local node-type name, a key in `nodes`
    to: string;                  
    // sh:minCount, default 0
    min?: number;                
    // sh:maxCount, null = unbounded
    max?: number | null;         
}

/** Author-facing input: node refs are schema names OR ids. */
export interface BundleInput {
    // the set of nodes in the bundle (i.e. field -> schema)
    nodes: Record<string, string>;   
    // the set of edges connecting each node
    edges: EdgeShape[];
}

/** Committed form: node refs resolved + pinned to schemaIds. */
export interface ResolvedBundle {
    // "Track" -> schemaId
    nodes: Record<string, Hex>;      
    edges: EdgeShape[];
}

/** The on-storage bundle shape (what specCid points to for a bundle). */
export interface BundleShape {
    "@kind": "bundle";
    bundle: ResolvedBundle;
}

// Composed View (docs/CROSS_PUBLISHER_LINKING.md, Phase 1).
//
// A view is *just another datasource* whose content is the fusion of several
// existing datasources. It composes them by their global identity (Entity URIs +
// aliases from Phase 0) — no ML, deterministic. It registers/publishes through
// the same schema/registry path as a resolver or bundle.

/** Author-facing input: the datasource resourceIds to fuse, plus optional
 *  linksets (asserted cross-edges, Phase 2) and a trust policy (Phase 4). */
export interface ViewInput {
    // datasource resourceIds to compose (0x + 64 hex each)
    sources: Hex[];
    // asserted-edge linkset artifact ids; unused until Phase 2
    linksets?: Hex[];
    // trust policy; opaque + unused until Phase 4
    trust?: Record<string, unknown>;
    // OPTIONAL discovery hint: the schemaIds backing the sources/linksets above.
    // resourceId = keccak(owner, schemaId, datasetName) is NOT indexed by the
    // subgraph, so a consumer must otherwise scan the whole publish history to map
    // a source resourceId → its manifest. Recording the schemaIds lets the consumer
    // run cheap per-schema queries instead. A pure hint (not all sources need be
    // covered — e.g. foreign resourceIds whose schemaId is unknown); the consumer
    // falls back to a global scan for anything left unresolved.
    sourceSchemas?: Hex[];
}

/** Committed form: sources validated, deduped + sorted; linksets/trust defaulted. */
export interface ResolvedView {
    sources: Hex[];
    linksets: Hex[];
    trust: Record<string, unknown>;
    sourceSchemas: Hex[];
}

// Linkset (docs/CROSS_PUBLISHER_LINKING.md, Phase 2).
//
// A linkset is *just another datasource* whose records are asserted cross-edges
// between entities — the **fuzzy** join, for when two publishers describe the
// same thing with no shared id. Its endpoints are global (Entity URIs or
// namespaced aliases) and may be **foreign** (point into someone else's
// datasource). It publishes through the same Merkle/registry path; it is signed
// by whoever commits it, so *who asserted a link* is a trust input (Phase 4).

/** One asserted cross-edge. `from`/`to` are Entity URIs or namespaced aliases
 *  (`isrc:…`), and may reference entities in foreign datasources. `rel` is the
 *  asserted relation — `sameAs` (RESERVED_SAMEAS_REL) merges equivalence classes;
 *  others just add edges. `confidence` ∈ [0,1]; `evidence` is opaque provenance. */
export interface LinkRecord {
    from: string;
    rel: string;
    to: string;
    confidence?: number;
    evidence?: Record<string, unknown>;
}

/** Author-facing input: an optional allowlist of relations this linkset asserts.
 *  Empty/omitted = any non-empty relation is accepted. */
export interface LinksetInput {
    rels?: string[];
}

/** Committed form: rels deduped + sorted (empty = any relation allowed). */
export interface ResolvedLinkset {
    rels: string[];
}

interface SchemaBlobBase {
    name: string;
    owner: Hex;
    createdAt: string;
}
export interface ResolverSchemaBlob extends SchemaBlobBase {
    kind: "resolver";
    definition: SchemaDefinition;
    // optional custom-type vocabulary referenced by fields in `definition`
    types?: Record<string, TypeDefinition>;
    // optional Phase-0 identity declaration (Entity URI @id + namespaced aliases)
    identity?: NodeIdentity;
}
export interface BundleSchemaBlob extends SchemaBlobBase {
    kind: "bundle";
    bundle: ResolvedBundle;
}
export interface ViewSchemaBlob extends SchemaBlobBase {
    kind: "view";
    view: ResolvedView;
}
export interface LinksetSchemaBlob extends SchemaBlobBase {
    kind: "linkset";
    linkset: ResolvedLinkset;
}
export type SchemaBlob = ResolverSchemaBlob | BundleSchemaBlob | ViewSchemaBlob | LinksetSchemaBlob;

export interface SchemaRoleConfig {
    chainId: number;
    rpcUrl: string;
    privateKey: Hex;
    pinataJwt: string;
    /** Optional — override ERC-8004 registry addresses per chainId */
    registryOverrides?: Record<number, { IDENTITY: string; REPUTATION: string }>;
    /** Optional — override subgraph URLs per chainId */
    subgraphOverrides?: Record<number, string>;
}