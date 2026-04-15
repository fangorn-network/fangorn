import { type Address, type Hex } from "viem";

// ── Input types (supplied by publisher) ──────────────────────────────────────

/**
 * A single field value supplied by the publisher.
 * If the value is already stored externally, use a HandleFieldInput instead.
 */
export type FieldInput =
    | string
    | number
    | boolean
    | Uint8Array
    | HandleFieldInput

/**
 * A field whose content already lives in a storage backend.
 * The publisher supplies the URI directly — no encrypt/store step occurs.
 * Examples:
 *   "r2://tracks/song.mp3"
 *   "ipfs://QmXyz..."
 */
export interface HandleFieldInput {
    "@type": "handle"
    uri: string
}

/**
 * One schema-conformant record to publish.
 * `name` uniquely identifies this record within (owner, schemaId) —
 * it maps to the resourceId in the SettlementRegistry.
 */
export interface PublishRecord {
    name: string
    fields: Record<string, FieldInput>
}

// ── Resolved types (written to manifest) ─────────────────────────────────────

/**
 * A resolved handle field — points to content in a storage backend.
 * The URI scheme identifies the backend:
 *   r2://   → Fangorn access worker (requires settlement proof)
 *   ipfs:// → public IPFS gateway
 */
export interface ResolvedHandleField {
    "@type": "handle"
    uri: string
    // resourceId: Hex
    // gadgetDescriptor: GadgetDescriptor
}

/** A resolved plain field — stored inline in the manifest */
export type ResolvedPlainField = string | number | boolean | Uint8Array

export type ResolvedField = ResolvedPlainField | ResolvedHandleField

/**
 * A manifest entry — one schema-conformant record with all fields resolved.
 * Plain fields are readable by anyone directly from the manifest.
 * Handle fields require the consumer to fetch via the appropriate backend.
 */
export interface ManifestEntry {
    name: string
    fields: Record<string, ResolvedField>
}

// ── Manifest ──────────────────────────────────────────────────────────────────

export interface Manifest {
    version: 2          // bumped — handle shape changed, gadgetDescriptor removed
    schemaId: Hex
    entries: ManifestEntry[]
}

// ── Params / Results ──────────────────────────────────────────────────────────

export interface UploadParams {
    records: PublishRecord[]
    /**
     * The unique name of the schema the records must conform to.
     */
    schemaName: string
    /**
     * Configurable gas for the on-chain publish call.
     */
    gas?: bigint
    options?: {
        /**
         * When false (default) the existing manifest for this (owner, schemaId)
         * is loaded and merged — existing records not in this upload are kept.
         * When true the manifest is fully replaced.
         */
        overwrite?: boolean
    }
}

export interface CommitResult {
    manifestUri: string     // renamed from manifestCid — no longer necessarily a CID
    schemaId: Hex
    owner: Address
    entryCount: number
}