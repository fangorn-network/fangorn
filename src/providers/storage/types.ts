import type { CID } from "multiformats/cid";

/**
 * A backend-agnostic interface for storing and retrieving opaque content.
 */
export interface StorageMeta {
  name?: string
  [key: string]: unknown
}

/** A content-addressed block whose CID is already known to the caller. */
export interface RawBlock {
  cid: CID
  bytes: Uint8Array
}

export interface MetadataStorage {

  /**
   * Store content and return an opaque URI.
   * Callers never construct or parse URIs, they  should be treated as handles.
   */
  put(data: unknown, meta?: StorageMeta): Promise<string>

  /**
     * Pack multiple items into a single upload
     * Returns a map of { name -> identifier } for each item
     */
  putMany(items: { data: unknown; name: string }[]): Promise<Record<string, string>>

  /**
   * Upload precomputed (cid, bytes) blocks, preserving their exact CIDs so
   * they remain retrievable by `get(cid.toString())`.
   */
  putBlocks(blocks: RawBlock[]): Promise<void>

  /**
   * Retrieve content by URI previously returned from put().
   */
  get<T>(uri: string): Promise<T>

  /**
   * Retrieve the exact raw bytes for a block CID, with no decoding applied —
   * what content-addressed tree traversal (e.g. the Pail blockstore adapter)
   * needs, as opposed to get()'s already-decoded logical payload.
   */
  getRawBlock(uri: string): Promise<Uint8Array>

  /**
   * Delete content by URI
   */
  delete(uri: string): Promise<void>
}
