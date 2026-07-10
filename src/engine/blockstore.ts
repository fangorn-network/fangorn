import type { Blockstore, Pair } from 'interface-blockstore';
import type { AbortOptions } from 'interface-store';
import { CID } from 'multiformats/cid';
import { MetadataStorage } from '../providers/storage';

export class StorageBlockstoreAdapter implements Blockstore<any, any, any, any, any, any, any, any> {
    constructor(private storage: MetadataStorage) { }
    
    async put(key: any, val: Uint8Array, options?: AbortOptions): Promise<any> {
        const fileBlob = new Blob([val as any], { type: 'application/octet-stream' });

        // Force the Blob through the StorageMeta type constraint
        await this.storage.put(key.toString(), fileBlob as any);
        return key;
    }

    async get(key: any, options?: AbortOptions): Promise<Uint8Array> {
        // Force the return type to bypass StorageMeta property checks
        const fileBlob = await this.storage.get(key.toString()) as any;

        const arrayBuffer = await fileBlob.arrayBuffer();
        return new Uint8Array(arrayBuffer);
    }
    async has(key: any, options?: AbortOptions): Promise<boolean> {
        try {
            await this.get(key, options);
            return true;
        } catch {
            return false;
        }
    }

    async delete(key: any, options?: AbortOptions): Promise<void> { }

    async *putMany(blocks: AsyncIterable<any> | Iterable<any>, options?: AbortOptions): AsyncIterable<any> {
        for await (const { cid, block } of blocks) {
            await this.put(cid, block, options);
            yield cid;
        }
    }

    async *getMany(cids: AsyncIterable<any> | Iterable<any>, options?: AbortOptions): AsyncIterable<any> {
        for await (const cid of cids) {
            const block = await this.get(cid, options);
            yield { cid, block };
        }
    }

    async *deleteMany(cids: AsyncIterable<any> | Iterable<any>, options?: AbortOptions): AsyncIterable<any> {
        for await (const cid of cids) {
            yield cid;
        }
    }

    async *blocks(options?: AbortOptions): AsyncIterable<any> { }
    async *getAll(options?: AbortOptions): AsyncIterable<any> { }
}