export default interface StorageProvider<T> {
	store(data: T, metadata?: Record<string, unknown>): Promise<string>;
	retrieve(cid: string): Promise<T>;
	delete?(cid: string): Promise<void>;
}
