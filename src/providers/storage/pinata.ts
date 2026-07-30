import { encode } from "multiformats/block";
import { PinataSDK } from "pinata";
import * as dagCbor from "@ipld/dag-cbor";
import { MetadataStorage, RawBlock, StorageMeta } from "./types.js";
import {
	decodeJsonOrText,
	rawBlockRef,
	retrieveByCid,
	serialize,
	withUploadRetry,
} from "./utils.js";
import { packCar } from "../../engine/car.js";
import { errorMessage, sleep } from "../../utils/index.js";
import { keccak256, stringToBytes } from "viem";
import { sha256 } from "multiformats/hashes/sha2";

// A plain (non-CAR) Pinata file upload of small content assigns a CIDv1 with the
// raw codec (0x55, see RAW_CODE in ./utils.ts) over the exact same sha256 digest
// as a dag-cbor CID (0x71) of the identical bytes — verified empirically against
// Pinata's public upload + gateway. CAR uploads (`.car()`) do NOT reliably
// resolve individual/sub-root block CIDs on this account's dedicated gateway
// (confirmed: even a single-block CAR whose root IS the block 403s as "not
// pinned"), so blocks that need to be retrievable by their own precomputed
// CID must go through the plain upload path and be looked up via this
// raw-codec sibling.

export class PinataBackend implements MetadataStorage {
	private pinata: PinataSDK;
	private gateway: string;

	constructor(pinataJwt: string, pinataGateway: string) {
		this.pinata = new PinataSDK({ pinataJwt, pinataGateway });
		this.gateway = pinataGateway;
	}

	async put(data: unknown, meta?: StorageMeta): Promise<string> {
		const content = serialize(data);
		const name = meta?.name ?? "file";
		return withUploadRetry(name, async () => {
			const file = new File([content], name, { type: "text/plain" });
			const upload = await this.pinata.upload.public.file(file, {
				metadata: meta,
			});
			return upload.cid;
		});
	}

	async update(data: unknown, meta?: StorageMeta): Promise<string> {
		const content = serialize(data);
		const name = meta?.name ?? "file";

		return withUploadRetry(name, async () => {
			const file = new File([content], name, { type: "text/plain" });

			// 1. Upload the file to get the CID and Pinata's internal File UUID
			const upload = await this.pinata.upload.public.file(file).name(name);

			// 2. Compute the state root deterministically from the generated CID
			const stateRoot = keccak256(stringToBytes(upload.cid)).toLowerCase();

			// 3. Automatically patch the metadata so it's instantly indexable by state root
			await this.pinata.files.public.update({
				// Must use the file's unique Pinata ID here
				id: upload.id,
				keyvalues: { stateRoot },
			});

			// 4. Return the clean CID back to Fangorn
			return upload.cid;
		});
	}

	/**
	 * Pack every item into ONE locally-built CAR and upload it as a single pin,
	 * collapsing N uploads into one request. Returns each item's `ipfs://<root>/<name>`
	 * path URI: a CAR upload registers only the directory root as a "file", so the
	 * dedicated gateway serves chunks by path through that root (bare sub-block CIDs
	 * 403). Callers must bound batch size — the CAR is built in memory.
	 */
	async putMany(
		items: { data: unknown; name: string }[],
	): Promise<Record<string, string>> {
		if (items.length === 0) return {};

		const blocks = [];
		const uriByName: Record<string, string> = {};

		// 1. Encode your raw data items into standard IPLD blocks
		for (const item of items) {
			const block = await encode({
				value: item.data,
				codec: dagCbor,
				hasher: sha256
			});

			blocks.push(block);
			uriByName[item.name] = `ipfs://${block.cid.toString()}`;
		}

		// 2. Create a Root Block (CAR v1 strictly requires a root CID)
		// We can bundle the uriByName map into a root manifest block.
		const rootBlock = await encode({
			value: uriByName,
			codec: dagCbor,
			hasher: sha256
		});
		blocks.push(rootBlock);

		// 3. Use your new packCar function
		const bytes = await packCar(rootBlock.cid, blocks);

		// 4. Upload
		const label = `car[${items.length.toString()}f/${(bytes.length / 1e6).toFixed(1)}MB]`;
		await withUploadRetry(label, async () => {
			const file = new File([bytes.buffer as ArrayBuffer], "data.car", {
                type: "application/vnd.ipld.car",
            });
			await this.pinata.upload.public.file(file).car();
		});

		return uriByName;
	}

	/**
	 * Upload ONE precomputed (cid, bytes) block as a plain-file pin so it's
	 * individually addressable on the dedicated gateway via its raw-codec
	 * sibling CID (see RAW_CODE comment above for why this can't go through
	 * `.car()`). Only commit blocks take this path — one small upload per
	 * commit; everything else travels inside the commit's CAR via putFile().
	 */
	async putBlock(block: RawBlock): Promise<void> {
		const { cid, bytes } = block;
		await withUploadRetry(cid.toString(), async () => {
			const file = new File([bytes as BlobPart], cid.toString(), {
				type: "application/octet-stream",
			});
			await this.pinata.upload.public.file(file);
		});
	}

	/**
	 * Store opaque bytes (a commit's CAR file) as a single plain-file pin.
	 * Deliberately NOT `.car()`: the CAR is a packfile we read back whole, so
	 * Pinata never needs to understand its inner blocks. Returns the file's
	 * CID as the URI handle.
	 */
	async putFile(bytes: Uint8Array, name: string): Promise<string> {
		return withUploadRetry(name, async () => {
			const file = new File([bytes as BlobPart], name, {
				type: "application/octet-stream",
			});
			const upload = await this.pinata.upload.public.file(file);
			return upload.cid;
		});
	}

	/** Fetch back the exact bytes stored via putFile(). */
	async getFile(uri: string): Promise<Uint8Array> {
		const { bytes } = await this.fetchRaw(uri);
		return bytes;
	}

	async get<T>(uri: string): Promise<T> {
		const { bytes, isDagCborCid, contentType } = await this.fetchRaw(uri);

		if (isDagCborCid || contentType === "application/octet-stream") {
			return dagCbor.decode(bytes);
		}
		// Non-binary content: decode as UTF-8 text/JSON, matching the shape the
		// Pinata SDK would have handed back directly for a text payload.
		return decodeJsonOrText(bytes) as T;
	}

	/** Raw bytes for a block CID, with no decoding — what blockstore traversal needs. */
	async getRawBlock(uri: string): Promise<Uint8Array> {
		const { bytes } = await this.fetchRaw(uri);
		return bytes;
	}

	/**
	 * Shared fetch-with-retry: resolves the raw-codec sibling CID for blocks
	 * uploaded via putBlock(), fetches from the dedicated gateway, and returns
	 * the exact bytes (never pre-decoded) plus enough context for get<T>() to
	 * decide how to decode them.
	 */
	private async fetchRaw(
		uri: string,
	): Promise<{
		bytes: Uint8Array;
		isDagCborCid: boolean;
		contentType: string | null | undefined;
	}> {
		let attempts = 5;
		let lastError: unknown; // Fixed: Swapped explicit 'any' for 'unknown'

		// Blocks uploaded via putBlock() land under a raw-codec (0x55) CID
		// sharing the dag-cbor CID's digest — translate before fetching.
		const { fetchCid: fetchUri, isDagCborCid } = rawBlockRef(uri);

		while (attempts > 0) {
			try {
				// Let the SDK perform its signed fetch
				const { data, contentType } =
					await this.pinata.gateways.public.get(fetchUri);

				const bytes =
					data instanceof Blob
						? new Uint8Array(await data.arrayBuffer())
						: data instanceof ArrayBuffer
							? new Uint8Array(data)
							: data instanceof Uint8Array
								? data
								: new TextEncoder().encode(
									typeof data === "string" ? data : JSON.stringify(data),
								);

				return { bytes, isDagCborCid, contentType };
			} catch (error: unknown) { // Fixed: Changed catch binding from 'any' to 'unknown'
				// If it's a Pinata replication lag error (ERR_ID:00006 or 403/404), back off and retry
				lastError = error; // Safe assignment because both sides are now 'unknown'
				attempts--;

				if (attempts === 0) break;

				// Wait 1 second before trying again to allow the gateway ledger to sync
				await sleep(1000);
			}
		}

		throw new Error(
			`Pinata SDK failed to retrieve block ${uri} after multiple attempts. Internal Error: ${errorMessage(lastError)}`,
		);
	}

	static async getStatic<T>(uri: string, gateway?: string): Promise<T> {
		return retrieveByCid<T>(uri, gateway);
	}

	/// Queries Pinata's indexed metadata for the matching EVM root hash
	async getCidByStateRoot(
		stateRoot: string,
		retries = 5,
		delay = 1000,
	): Promise<string> {
		const formattedRoot = stateRoot.toLowerCase();

		for (let i = 0; i < retries; i++) {
			const response = await this.pinata.files.public
				.list()
				.keyvalues({ stateRoot: formattedRoot });

			if (response.files.length > 0) {
				return response.files[0].cid;
			}

			// If we haven't found it yet, pause and let the cloud indexer propagate
			if (i < retries - 1) {
				console.warn(
					`
                    [Pinata] Indexing lag detected for root ${formattedRoot}. Retrying in ${(delay * (i + 1)).toString()}ms...
                    `,
				);
				await sleep(delay * (i + 1));
			}
		}

		throw new Error(
			`No matching IPFS CID found for state root: ${stateRoot} after ${retries.toString()} retrieval attempts.`,
		);
	}

	async delete(uri: string): Promise<void> {
		await this.pinata.files.public.delete([uri]);
	}
}
