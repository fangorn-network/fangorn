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
    encryption?: {
        gadget: string;          // e.g. "tee-aes-v1"
        ciphertextHash: string;  // sha256 hex of the bytes at uri
        // Explicit TEE public key for the sealed-encryption gadget. Inline for
        // now; once the gadget registry is live this becomes resolvable via
        // lookup instead of being carried in the manifest. See examples/sealed-e2e.ts.
        teePubkey?: string;      // hex-encoded X25519 public key
    };
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
 * wait do I really even need this?
 * Resolved manifest fields
 */

export interface ResolvedHandleField {
    "@type": "handle";
    uri: string;
    workerUrl: string;
    encryption?: {
        gadget: string;          // e.g. "tee-aes-v1"
        ciphertextHash: string;  // sha256 hex of the bytes at uri
        teePubkey?: string;      // hex-encoded X25519 public key (see HandleFieldInput)
    };
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
  nodeChunks: { type: string; dataCid: string; leaf: Hex; contentId?: string }[];
  /** Edges chunked into many leaves (one bundle = one merkle root over all of them). */
  edgeChunks: { dataCid: string; leaf: Hex; contentId?: string }[];
  tree: Hex[][];
}

export interface BundleNode {
    id: string;
    type: string;
    // Phase 0 global identity (docs/CROSS_PUBLISHER_LINKING_PLAN.md §3): the
    // canonical Entity URI `fangorn:<resourceId>/<localId>` and any namespaced
    // aliases (e.g. "gplace:ChIJ…") declared on the node type. quickbeam keys
    // cross-datasource adjacency on these.
    entityUri: string;
    aliases: string[];
    fields: Record<string, ResolvedField>;
}

export interface BundleEdge {
    rel: string;
    from: string; // node id
    to: string;   // node id
}

/**
 * Composed-view manifest (docs/CROSS_PUBLISHER_LINKING_PLAN.md §4). A view is
 * just another datasource whose published content is its *declaration* — the
 * set of source datasources (plus optional linksets/trust) that a downstream
 * indexer (quickbeam) fuses into one graph. The single `viewChunk` leaf is what
 * the merkle root commits to, so the on-chain root attests the declared inputs.
 */
export interface ViewManifest {
    kind: "view";
    schemaId: Hex;
    root: Hex;
    sources: Hex[];
    linksets: Hex[];
    trust: Record<string, unknown>;
    // Discovery hint: schemaIds backing the sources/linksets, so a consumer can
    // resolve each source via cheap per-schema queries instead of scanning the
    // whole publish history. May be empty / incomplete (see ViewInput.sourceSchemas).
    sourceSchemas: Hex[];
    viewChunk: { dataCid: string; leaf: Hex; contentId?: string };
    tree: Hex[][];
}

/**
 * Linkset manifest (docs/CROSS_PUBLISHER_LINKING_PLAN.md §5). A linkset is a
 * datasource whose records are asserted cross-edges; like a bundle's edges they
 * are chunked into many merkle leaves under one root, so the committed root
 * attests the exact set of asserted links (and who signed them).
 */
export interface LinksetManifest {
    kind: "linkset";
    schemaId: Hex;
    root: Hex;
    linkChunks: { dataCid: string; leaf: Hex; contentId?: string }[];
    tree: Hex[][];
}

export interface HydratedBundle {
    nodesById: Map<string, BundleNode>;
    edges: BundleEdge[];
}