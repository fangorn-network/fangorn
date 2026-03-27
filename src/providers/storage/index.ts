export * from "./pinata/index.js";

/**
 * Read-only storage (e.g. for a consuming party)
 * Does not require any authentication
 */
export interface ReadableStorage<T> {
	retrieve(cid: string): Promise<T>;
}

/**
 * Read/Write storage
 * (Likely) Requires authentication.
 */
export interface WritableStorage<T> extends ReadableStorage<T> {
	store(data: T, metadata?: Record<string, unknown>): Promise<string>;
	delete(cid: string): Promise<void>;
}
