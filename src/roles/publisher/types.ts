import { type Hex } from "viem";

export type FieldInput =
    | null
    | string
    | number
    | boolean
    | Uint8Array
    | string[]
    | number[]
    | boolean[]
    | null[]
    | FieldInputObject
    | FieldInputObject[]
    | HandleFieldInput
    | HandleArray;

export interface FieldInputObject {
    [key: string]: FieldInput;
}

export interface HandleArray {
    "@type": "array";
    items: HandleFieldInput[];
}

export interface ResolvedHandleArray {
    "@type": "array";
    items: ResolvedHandleField[];
}

export interface HandleFieldInput {
    "@type": "handle";
    uri: string;
    workerUrl: string;
}

/**
 * One schema-conformant record to publish.
 * `name` uniquely identifies this record within (owner, schemaId) —
 * it maps to the resourceId in the SettlementRegistry.
 */
export interface PublishRecord {
    name: string;
    fields: Record<string, FieldInput>;
}

/**
 * Resolved manifest fields
 */

export interface ResolvedHandleField {
    "@type": "handle";
    uri: string;
    workerUrl: string;
}

export type ResolvedPlainField =
    | null
    | string
    | number
    | boolean
    | Uint8Array
    | string[]
    | number[]
    | boolean[]
    | null[]
    | ResolvedObject
    | ResolvedObject[];

export interface ResolvedObject {
    [key: string]: ResolvedPlainField;
}

export type ResolvedField =
    | ResolvedPlainField
    | ResolvedHandleField
    | ResolvedHandleArray;

export interface ManifestLeaf {
    index: bigint;
    name: string;
}

/// each "leaf" looks like one of these
export interface ManifestEntry {
    name: string;
    fields: Record<string, unknown>;
}

/**
 * Dataset manifest
 */

export interface Manifest {
    kind: "record-set";
    schemaId: Hex;
    /**
     * Poseidon2 Merkle root
     */
    root: Hex;
    /**
     * Entire dataset
     */
    entries: ManifestEntry[];
    /**
     * Full Merkle tree layers
     *
     * layer[0] = leaves
     * layer[last][0] = root
     */
    tree: Hex[][];
}

export interface BundleManifest {
  kind: "bundle";
  schemaId: Hex;
  root: Hex;
  nodeChunks: { type: string; dataCid: string; leaf: Hex }[];
  /** Edges chunked into many leaves (one bundle = one merkle root over all of them). */
  edgeChunks: { dataCid: string; leaf: Hex }[];
  tree: Hex[][];
}

export interface BundleNode {
  id: string;
  type: string;
  fields: Record<string, ResolvedField>;
}

export interface BundleEdge {
  rel: string;
  from: string; // node id
  to: string;   // node id
}

export interface HydratedBundle {
  nodesById: Map<string, BundleNode>;
  edges: BundleEdge[];
}