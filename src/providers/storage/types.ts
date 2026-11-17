import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { equals } from "multiformats/bytes";

/**
 * A backend-agnostic interface for storing and retrieving opaque content.
 */
export interface StorageMeta {
	name?: string;
	[key: string]: unknown;
}

/** A content-addressed block whose CID is already known to the caller. */
export interface RawBlock {
	cid: CID;
	bytes: Uint8Array;
}

export interface MetadataStorage {
	/**
	 * Store content and return an opaque URI.
	 * Callers never construct or parse URIs, they  should be treated as handles.
	 */
	put(data: unknown, meta?: StorageMeta): Promise<string>;

	/**
	 * Pack multiple items into a single upload
	 * Returns a map of { name -> identifier } for each item
	 */
	putMany(
		items: { data: unknown; name: string }[],
	): Promise<Record<string, string>>;

	/**
	 * Upload ONE precomputed (cid, bytes) block, preserving its exact CID so it
	 * stays retrievable via `getRawBlock(cid.toString())`. Used only for commit
	 * blocks — one small upload per commit; bulk data travels inside CAR files
	 * via `putFile`.
	 */
	putBlock(block: RawBlock): Promise<void>;

	/**
	 * Store an opaque byte payload (e.g. a CAR file) and return its CID.
	 * The backend is NOT expected to understand the contents.
	 */
	putFile(bytes: Uint8Array, name: string): Promise<string>;

	/**
	 * Retrieve the exact bytes previously stored with putFile().
	 */
	getFile(uri: string): Promise<Uint8Array>;

	/**
	 * Retrieve content by URI previously returned from put().
	 */
	get<T>(uri: string): Promise<T>;

	/**
	 * Retrieve the exact raw bytes for a block CID, with no decoding applied —
	 * how commit blocks written with putBlock() are read back.
	 */
	getRawBlock(uri: string): Promise<Uint8Array>;

	/**
	 * Delete content by URI
	 */
	delete(uri: string): Promise<void>;
}

const RAW_CODE = 0x55;
const SHA2_256 = 0x12;

/**
 * Check the CID a backend says it stored `block` under. Readers fetch a block by
 * its raw-codec sibling (same sha256 digest), so any other answer means the block
 * is unreadable: fail the upload, not every later read of the head that names it.
 */
export function assertStoredBlock(returned: string, block: RawBlock): void {
	let cid: CID | undefined;
	try {
		cid = CID.parse(returned.replace(/^ipfs:\/\//, ""));
	} catch {
		/* reported below */
	}
	const want = CID.createV1(RAW_CODE, block.cid.multihash);
	if (!cid?.equals(want))
		throw new Error(
			`storage stored block ${block.cid.toString()} as ${JSON.stringify(returned)}, expected ${want.toString()}: readers could not fetch it`,
		);
}

/**
 * Check the CID a backend says it stored `bytes` under, where it can be checked
 * locally: a single raw sha256 block. A chunked (dag-pb) file is left to the
 * per-block hash checks on read.
 */
export async function assertStoredFile(
	returned: string,
	bytes: Uint8Array,
): Promise<void> {
	let cid: CID;
	try {
		cid = CID.parse(returned.replace(/^ipfs:\/\//, ""));
	} catch {
		return; // not a CID at all: the caller's own parse (fileCid) reports it
	}
	if (cid.code !== RAW_CODE || cid.multihash.code !== SHA2_256) return;
	const digest = await sha256.digest(bytes);
	if (!equals(cid.multihash.digest, digest.digest))
		throw new Error(
			`storage returned ${returned} for ${String(bytes.length)} bytes whose sha256 does not match it`,
		);
}
