//
// Copyright (c) Fangorn LLC and contributors. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.
//

import { type Hex } from "viem";

// there are two 'kind' of schemas
// the resolver type refers to 'raw' schemas that need to be resolved (e.g. a well-defined schema def)
// while bundle refers to a BundleInput
export type SchemaKind = "resolver" | "bundle";

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

export interface FieldDefinition {
    "@type": string;
    "@description"?: string;
    items?: FieldDefinition | Record<string, FieldDefinition>;
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

interface SchemaBlobBase {
    name: string;
    owner: Hex;
    createdAt: string;
}
export interface ResolverSchemaBlob extends SchemaBlobBase {
    kind: "resolver";
    definition: SchemaDefinition;
}
export interface BundleSchemaBlob extends SchemaBlobBase {
    kind: "bundle";
    bundle: ResolvedBundle;
}
export type SchemaBlob = ResolverSchemaBlob | BundleSchemaBlob;

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