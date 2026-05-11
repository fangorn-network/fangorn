import { type Address, type Hex } from "viem";

/**
 * A single field value supplied by the publisher.
 * Supports primitives, nullable variants, arrays, objects, and handle fields.
 */
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

/**
 * A field whose content already lives in a storage backend.
 * The publisher supplies the URI directly — no encrypt/store step occurs.
 * Examples:
 *   "r2://tracks/song.mp3"
 *   "ipfs://QmXyz..." [future]
 */
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

// Resolved types (written to manifest)

/**
 * A resolved handle field — points to content in a storage backend.
 * The URI scheme identifies the backend:
 *   r2://   → Fangorn access worker (requires settlement proof)
 *   ipfs:// → public IPFS gateway [future]
 */
export interface ResolvedHandleField {
    "@type": "handle";
    uri: string;
    workerUrl: string;
    price: string;
}

/** A resolved plain field, stored inline in the manifest */
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

/**
 * A manifest entry; one schema-conformant record with all fields resolved.
 * Plain fields are readable by anyone directly from the manifest.
 * Handle fields require the consumer to fetch via the appropriate backend.
 */
export interface ManifestEntry {
    name: string;
    fields: Record<string, ResolvedField>;
}

// Manifest
export interface Manifest {
    version: 2;
    schemaId: Hex;
    entries: ManifestEntry[];
}

// Params / Results
export interface UploadParams {
    records: PublishRecord[];
    /**
     * The unique name of the schema the records must conform to.
     */
    schemaName: string;
    /**
     * Configurable gas for the on-chain publish call.
     */
    gas?: bigint;
    options?: {
        /**
         * When false (default) existing entries are preserved.
         * When true the manifest is fully replaced.
         */
        overwrite?: boolean;
    };
}

export interface CommitResult {
    manifestUri: string;
    schemaId: Hex;
    owner: Address;
    entryCount: number;
}