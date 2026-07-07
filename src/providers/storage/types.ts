/**
 * A backend-agnostic interface for storing and retrieving opaque content.
 */
export interface StorageMeta {
  name?: string
  [key: string]: unknown
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
   * Retrieve content by URI previously returned from put().
   */
  get<T>(uri: string): Promise<T>

  /**
   * Delete content by URI
   */
  delete(uri: string): Promise<void>
}
