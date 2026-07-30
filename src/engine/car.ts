import { CarWriter, CarReader } from "@ipld/car";
import { CID } from "multiformats/cid";
import type { Block } from "./graph.js";
import { concatBytes } from "../utils/index.js";

// CAR (de)serialization for commit deltas. A commit's CAR is treated as an
// OPAQUE FILE by the storage backend — we never rely on the backend indexing
// its inner blocks (Pinata's dedicated gateways demonstrably don't; see
// providers/storage/pinata.ts). Readers download the whole CAR and load its
// blocks into a local cache, git-packfile style.

/**
 * Serialize blocks into CAR v1 bytes under a single root.
 *
 * `release` hands each block back to the GC as soon as the writer has
 * serialized it, keeping peak memory at ~2× the packed size rather than 3× —
 * only safe when the caller owns the (mutable) array it passed in.
 */
export async function packCar(
	root: CID,
	blocks: Block[],
	{ release = false }: { release?: boolean } = {},
): Promise<Uint8Array> {
	const { writer, out } = CarWriter.create([root]);
	const collected: Uint8Array[] = [];
	const sink = (async () => {
		for await (const part of out) collected.push(part);
	})();
	for (let i = 0; i < blocks.length; i++) {
		await writer.put(blocks[i]);
		if (release) blocks[i] = undefined as unknown as Block;
	}
	await writer.close();
	await sink;

	return concatBytes(collected);
}

/** Decode CAR bytes back into blocks. */
export async function readCar(bytes: Uint8Array): Promise<Block[]> {
	const reader = await CarReader.fromBytes(bytes);
	const blocks: Block[] = [];
	for await (const { cid, bytes: blockBytes } of reader.blocks()) {
		// @ipld/car may carry its own multiformats build; normalize to ours.
		blocks.push({ cid: CID.parse(cid.toString()), bytes: blockBytes });
	}
	return blocks;
}
