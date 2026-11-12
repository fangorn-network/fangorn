import type { Hex } from "viem";
import type {
	MetadataStorage,
	RawBlock,
	StorageMeta,
} from "../providers/storage/types.js";
import { MemRegistry } from "../test/mem-registry.js";
import { readCar } from "./car.js";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";

export const ZERO_BYTES32 =
	"0x0000000000000000000000000000000000000000000000000000000000000000";

/** The raw 32-byte root hex a commit CID settles to on-chain (bare sha256 digest). */
export const rootHex = (commitCid: CID) =>
	`0x${Buffer.from(commitCid.multihash.digest).toString("hex")}` as const;

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

	async putFile(bytes: Uint8Array): Promise<string> {
		this.writes++;
		const uri = CID.createV1(raw.code, await sha256.digest(bytes)).toString();
		this.files.set(uri, bytes);
		return uri;
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

	/** Every block stored, loose or inside a CAR. */
	async allBlocks(): Promise<Map<string, Uint8Array>> {
		const out = new Map(this.blocks);
		for (const bytes of this.files.values())
			for (const b of await readCar(bytes, { verify: false }))
				out.set(b.cid.toString(), b.bytes);
		return out;
	}

	delete(_uri: string): Promise<void> {
		return Promise.resolve();
	}
}

/** The paper's registry in memory, signing as PUBLISHER. */
export const PUBLISHER = "0x0000000000000000000000000000000000000001" as Hex;
export const newRegistry = () => new MemRegistry(PUBLISHER);
