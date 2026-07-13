import { CarWriter, CarReader } from "@ipld/car";
import { CID } from "multiformats/cid";
import type { Block } from "./graph.js";

// CAR (de)serialization for commit deltas. A commit's CAR is treated as an
// OPAQUE FILE by the storage backend — we never rely on the backend indexing
// its inner blocks (Pinata's dedicated gateways demonstrably don't; see
// providers/storage/pinata.ts). Readers download the whole CAR and load its
// blocks into a local cache, git-packfile style.

/** Serialize blocks into CAR v1 bytes under a single root. */
export async function packCar(
	root: CID,
	blocks: Iterable<Block>,
): Promise<Uint8Array> {
	const { writer, out } = CarWriter.create([root]);
	const collected: Uint8Array[] = [];
	const sink = (async () => {
		for await (const part of out) collected.push(part);
	})();
	for (const block of blocks) {
		await writer.put(block);
	}
	await writer.close();
	await sink;

	let total = 0;
	for (const p of collected) total += p.length;
	const buf = new Uint8Array(total);
	let off = 0;
	for (const p of collected) {
		buf.set(p, off);
		off += p.length;
	}
	return buf;
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
