import type { Hex } from "viem";
import type {
	MetadataStorage,
	RawBlock,
	StorageMeta,
} from "../providers/storage/types.js";
import { ZERO_BYTES32, type DataRegistryClient } from "../contracts/index.js";
import { CID } from "multiformats/cid";
import { rootHexFromCid } from "./index.js";

export { ZERO_BYTES32 };

/** The raw 32-byte root hex a commit CID settles to on-chain (bare sha256 digest). */
export const rootHex = (commitCid: CID) => rootHexFromCid(commitCid);

/**
 * In-memory MetadataStorage: individually-pinned blocks + opaque files, with
 * write/read counters — remote writes are the publish cost driver, so tests
 * assert on them directly.
 */
export class MemStorage implements MetadataStorage {
	blocks = new Map<string, Uint8Array>();
	files = new Map<string, Uint8Array>();
	/** Remote uploads performed (putBlock + putFile). */
	writes = 0;
	/** Remote fetches performed (getRawBlock + getFile). */
	reads = 0;

	putBlock(block: RawBlock): Promise<void> {
		this.writes++;
		this.blocks.set(block.cid.toString(), block.bytes);
		return Promise.resolve();
	}

	putFile(bytes: Uint8Array, name: string): Promise<string> {
		this.writes++;
		const uri = `mem://${this.files.size.toString()}/${name}`;
		this.files.set(uri, bytes);
		return Promise.resolve(uri);
	}

	getFile(uri: string): Promise<Uint8Array> {
		const bytes = this.files.get(uri);
		if (!bytes) return Promise.reject(new Error(`no such file: ${uri}`));
		this.reads++;
		return Promise.resolve(bytes);
	}

	getRawBlock(uri: string): Promise<Uint8Array> {
		const bytes = this.blocks.get(uri);
		if (!bytes) return Promise.reject(new Error(`no such block: ${uri}`));
		this.reads++;
		return Promise.resolve(bytes);
	}

	put(_data: unknown, _meta?: StorageMeta): Promise<string> {
		return Promise.reject(new Error("MemStorage.put not implemented"));
	}

	putMany(
		_items: { data: unknown; name: string }[],
	): Promise<Record<string, string>> {
		return Promise.reject(new Error("MemStorage.putMany not implemented"));
	}

	get<T>(_uri: string): Promise<T> {
		return Promise.reject(new Error("MemStorage.get not implemented"));
	}

	delete(_uri: string): Promise<void> {
		return Promise.resolve();
	}
}

/**
 * Registry stub holding one head per namespace in memory (enough for the
 * engine) — mirroring the contract, where each namespace is its own timeline.
 */
export class StubRegistry {
	heads = new Map<string, Hex>();

	getNamespaceHead(_publisher: string, namespace: string): Promise<Hex> {
		return Promise.resolve(this.heads.get(namespace) ?? ZERO_BYTES32);
	}

	commitStateRoot(
		namespace: string,
		_oldRoot: Hex,
		newRoot: Hex,
	): Promise<Hex> {
		this.heads.set(namespace, newRoot);
		return Promise.resolve("0xdeadbeef" as Hex);
	}

	asClient(): DataRegistryClient {
		return this as unknown as DataRegistryClient;
	}
}
