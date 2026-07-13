import type { CID } from "multiformats/cid";

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
	 * Store an opaque byte payload (e.g. a CAR file) and return a URI handle.
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
