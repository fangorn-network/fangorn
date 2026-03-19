import { type Address, type Hex } from "viem";
import { Gadget } from "../../modules/gadgets";
import { SchemaDefinition } from "../schema/types";
import { GadgetDescriptor } from "../../modules/gadgets/types";

/**
 * A field value the publisher wants to store encrypted.
 * The `data` bytes are what get AES-encrypted and threshold-keyed via Lit.
 */
export interface EncryptedFieldInput {
	data: Uint8Array;
	fileType?: string;
	extension?: string;
}
 
/**
 * A single field value supplied by the publisher.
 * Plain types are stored as-is; EncryptedFieldInput goes through encryption.
 */
export type FieldInput =
	| string
	| number
	| boolean
	| Uint8Array
	| EncryptedFieldInput;
 
/**
 * One schema-conformant record to publish.
 * `tag` uniquely identifies this record within (owner, schemaId) —
 * it maps to the resourceId in the SettlementRegistry.
 */
export interface PublishRecord {
	tag: string;
	fields: Record<string, FieldInput>;
}
 
// ── Stored types (written to IPFS manifest) ───────────────────────────────────
 
/** A resolved encrypted field — what actually gets stored in the manifest entry */
export interface ResolvedEncryptedField {
	"@type": "encrypted";
	handle: { cid: string; gateway: string };
	gadgetDescriptor: GadgetDescriptor;
}
 
/** A resolved plain field value — stored as-is */
export type ResolvedPlainField = string | number | boolean | Uint8Array;
 
export type ResolvedField = ResolvedPlainField | ResolvedEncryptedField;
 
/**
 * A manifest entry — one schema-conformant record with all fields resolved.
 * Plain fields are readable by anyone. Encrypted fields carry a handle
 * pointing to the ciphertext in IPFS and the gadget descriptor describing
 * the access condition.
 */
export interface ManifestEntry {
	tag: string;
	fields: Record<string, ResolvedField>;
}
 
// ── Manifest ──────────────────────────────────────────────────────────────────
 
export interface Manifest {
	version: 1;
	schemaId: Hex;
	entries: ManifestEntry[];
}
 
// ── Params ────────────────────────────────────────────────────────────────────
 
export interface UploadParams {
	records: PublishRecord[];
	/**
	 * The schema the records must conform to. Required — field-level encryption
	 * decisions are driven by the schema definition.
	 */
	schema: SchemaDefinition;
	schemaId: Hex;
	/**
	 * Called once per record to produce the gadget for that record's encrypted
	 * fields. All encrypted fields within a record share the same gadget —
	 * and therefore the same resourceId and access condition.
	 */
	gadgetFactory: (tag: string) => Gadget | Promise<Gadget>;
	/**
	 * IPFS gateway URL written into each encrypted field handle so consumers
	 * can retrieve ciphertexts without knowing the storage provider.
	 */
	gateway: string;
	options?: {
		/**
		 * When false (default) the existing manifest for this (owner, schemaId)
		 * is loaded and merged — existing records not in this upload are kept.
		 * When true the manifest is fully replaced.
		 */
		overwrite?: boolean;
	};
}
 
export interface CommitResult {
	manifestCid: string;
	schemaId: Hex;
	owner: Address;
	entryCount: number;
}

// export type UploadParams = {
//     files: Filedata[];
//     /**
//      * Called once per file to produce the gadget that governs its encryption.
//      * Can be async — useful when the gadget needs to fetch an on-chain condition.
//      */
//     gadgetFactory: (file: Filedata) => Gadget | Promise<Gadget>;
//     schemaId: Hex;
//     options?: {
//         /**
//          * When false (default) the existing manifest for this (owner, schemaId)
//          * pair is loaded and merged before the new files are staged.
//          * When true the existing manifest is ignored and fully replaced.
//          */
//         overwrite?: boolean;
//         /**
//          * If provided, the staged entries are validated against this definition
//          * before committing. Throws if any errors are found, saving a wasted
//          * IPFS pin + on-chain tx.
//          */
//         schema?: SchemaDefinition;
//     };
// };

// export type AddFileResult = {
//     tag: string;
//     cid: string;
// };

// export type CommitResult = {
//     manifestCid: string;
//     schemaId: Hex;
//     owner: Address;
//     entryCount: number;
// };