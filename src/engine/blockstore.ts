import type { Blockstore } from 'interface-blockstore';
import { CID } from 'multiformats/cid';
import { MetadataStorage } from '../providers/storage';

export class StorageBlockstoreAdapter implements Blockstore<any, any, any, any, any, any, any, any> {
    // Add a synchronized local memory map to bypass gateway lag during sequential test execution
    private memoryCache = new Map<string, Uint8Array>();
    // CIDs written locally since the last flush() — not yet uploaded to the remote backend
    private pendingCids = new Map<string, CID>();

    constructor(private storage: MetadataStorage) { }

    async put(key: any, val: Uint8Array, options?: any): Promise<any> {
        const cleanBytes = val.byteOffset === 0 && val.byteLength === val.buffer.byteLength
            ? val
            : val.slice();

        // `key` is usually a real CID, but pail/@ipld libs sometimes carry their
        // own bundled copy of multiformats, so `instanceof CID` can't be trusted
        // — normalize via CID.parse(key.toString()) to get an instance from
        // *our* multiformats.
        const cid = key instanceof CID ? key : CID.parse(key.toString());
        const lookupKey = cid.toString();

        // Write to local memory cache instantly so the next step can read it right away
        this.memoryCache.set(lookupKey, cleanBytes);
        this.pendingCids.set(lookupKey, cid);

        return key;
    }

    /** Uploads every block written locally since the last flush to the remote backend. */
    async flush(): Promise<void> {
        if (this.pendingCids.size === 0) return;

        const blocks = Array.from(this.pendingCids.values()).map(cid => ({
            cid,
            bytes: this.memoryCache.get(cid.toString())!,
        }));

        await this.storage.putBlocks(blocks);
        this.pendingCids.clear();
    }

    async *get(key: any, options?: any): AsyncGenerator<Uint8Array, void, unknown> {
        const lookupKey = key instanceof CID ? key.toString() : String(key);

        // 1. Check local cache first. If it exists here, return it immediately (0ms lag)
        if (this.memoryCache.has(lookupKey)) {
            yield this.memoryCache.get(lookupKey)!;
            return;
        }

        // 2. Fallback to remote network storage provider — raw bytes, undecoded.
        const remoteBytes = await this.storage.getRawBlock(lookupKey);
        if (!remoteBytes) {
            throw new Error(`Block payload missing for key: ${lookupKey}`);
        }

        // Populate cache for subsequent lookups
        this.memoryCache.set(lookupKey, remoteBytes);
        yield remoteBytes;
    }

    async has(key: any, options?: any): Promise<boolean> {
        const lookupKey = key instanceof CID ? key.toString() : String(key);
        if (this.memoryCache.has(lookupKey)) return true;
        try {
            const iterator = this.get(key, options);
            const next = await iterator.next();
            return !next.done;
        } catch {
            return false;
        }
    }

    async delete(key: any, options?: any): Promise<void> {
        const lookupKey = key instanceof CID ? key.toString() : String(key);
        this.memoryCache.delete(lookupKey);
    }

    async *putMany(blocks: AsyncIterable<any> | Iterable<any>, options?: any): AsyncGenerator<any, void, unknown> {
        for await (const { cid, block } of blocks) {
            await this.put(cid, block, options);
            yield cid;
        }
    }

    async *getMany(cids: AsyncIterable<any> | Iterable<any>, options?: any): AsyncGenerator<any, void, unknown> {
        for await (const cid of cids) {
            const chunks: Uint8Array[] = [];
            for await (const chunk of this.get(cid, options)) {
                chunks.push(chunk);
            }
            const flatBytes = new Uint8Array(chunks.reduce((acc, c) => acc + c.length, 0));
            let offset = 0;
            for (const chunk of chunks) {
                flatBytes.set(chunk, offset);
                offset += chunk.length;
            }
            yield { cid, block: flatBytes };
        }
    }

    async *deleteMany(cids: AsyncIterable<any> | Iterable<any>, options?: any): AsyncGenerator<any, void, unknown> {
        for await (const cid of cids) {
            this.delete(cid);
            yield cid;
        }
    }

    async *blocks(options?: any): AsyncGenerator<any, void, unknown> {
        // Yield nothing to satisfy empty stub requirements natively
    }

    async *getAll(options?: any): AsyncGenerator<any, void, unknown> {
        // Yield nothing but return the correct AsyncGenerator object layout
    }
}