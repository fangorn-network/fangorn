import * as dagPb from "@ipld/dag-pb";
import { UnixFS } from "ipfs-unixfs";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { equals } from "multiformats/bytes";

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
	 * Store an opaque byte payload (e.g. a CAR file) and return its CID.
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

const RAW_CODE = 0x55;
const SHA2_256 = 0x12;

/**
 * Check the CID a backend says it stored `block` under. Readers fetch a block by
 * its raw-codec sibling (same sha256 digest), so any other answer means the block
 * is unreadable: fail the upload, not every later read of the head that names it.
 */
export function assertStoredBlock(returned: string, block: RawBlock): void {
	let cid: CID | undefined;
	try {
		cid = CID.parse(returned.replace(/^ipfs:\/\//, ""));
	} catch {
		/* reported below */
	}
	const want = CID.createV1(RAW_CODE, block.cid.multihash);
	if (!cid?.equals(want))
		throw new Error(
			`storage stored block ${block.cid.toString()} as ${JSON.stringify(returned)}, expected ${want.toString()}: readers could not fetch it`,
		);
}

/** Verify the file reference before including it in a commit or paid handle. */
export async function assertStoredFile(
	returned: string,
	bytes: Uint8Array,
	storage?: Partial<Pick<MetadataStorage, "getRawBlock">>,
): Promise<void> {
	const root = CID.parse(returned.replace(/^ipfs:\/\//, ""));
	const mismatch = () =>
		new Error(`storage CID ${returned} does not match the uploaded bytes`);
	// A UnixFS root hashes its encoded node. Its links give the exact ranges
	// of the original file, so raw leaves can be verified without fetching them.
	async function verify(
		cid: CID,
		content: Uint8Array,
		depth: number,
	): Promise<void> {
		if (cid.multihash.code !== SHA2_256 || depth > 64) throw mismatch();
		if (cid.code === RAW_CODE) {
			if (!equals((await sha256.digest(content)).digest, cid.multihash.digest))
				throw mismatch();
			return;
		}
		if (cid.code !== dagPb.code || !storage?.getRawBlock) throw mismatch();
		const block = await storage.getRawBlock(cid.toString());
		if (!equals((await sha256.digest(block)).digest, cid.multihash.digest))
			throw mismatch();
		const { Data, Links } = dagPb.decode(block);
		if (!Data) throw mismatch();
		const file = UnixFS.unmarshal(Data);
		if (
			(file.type !== "file" && file.type !== "raw") ||
			file.blockSizes.length !== Links.length ||
			file.fileSize() !== BigInt(content.length)
		)
			throw mismatch();
		let offset = file.data?.length ?? 0;
		if (file.data && !equals(file.data, content.subarray(0, offset)))
			throw mismatch();
		for (const [i, link] of Links.entries()) {
			const size = Number(file.blockSizes[i]);
			if (size <= 0) throw mismatch();
			const end = offset + size;
			await verify(
				CID.decode(link.Hash.bytes),
				content.subarray(offset, end),
				depth + 1,
			);
			offset = end;
		}
	}
	await verify(root, bytes, 0);
}
