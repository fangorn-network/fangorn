/**
 * StorageBackend — backend-agnostic interface for storing and retrieving
 * opaque content. The URI returned by put() is the only thing callers
 * hold onto; get() knows how to resolve it.
 */
export interface StorageMeta {
  name?: string
  [key: string]: unknown
}

export interface MetadataStorage {
  /**
   * Store content and return an opaque URI.
   * Callers never construct or parse URIs — treat them as handles.
   */
  put(data: unknown, meta?: StorageMeta): Promise<string>

  /**
     * Pack multiple items into a single CAR and upload as one pin.
     * Returns a map of { name -> CID } for each item.
     */
  putMany(items: { data: unknown; name: string }[]): Promise<Record<string, string>>

  /**
   * Retrieve content by URI previously returned from put().
   */
  get<T>(uri: string): Promise<T>

  /**
   * Delete content by URI. Best-effort — implementations may no-op.
   */
  delete(uri: string): Promise<void>
}

/**
 * Proof required by access-controlled backends (e.g. R2 via the Fangorn worker).
 * Plain backends (e.g. IPFS) ignore this entirely.
 */
export interface AccessProof {
  nullifier: string
  resourceId: string
  timestamp: number
  signature: `0x${string}`
}