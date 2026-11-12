import {
	encodeAbiParameters,
	keccak256,
	stringToHex,
	zeroHash,
	type Hex,
} from "viem";
import { repoId, type UpdateEntry } from "./index.js";

// The contract's update log, a Merkle mountain range, rebuilt off chain.
// Must hash exactly as DataRegistry's `_append` and `logRoot` do.

const tag = (s: string) => stringToHex(s, { size: 32 });

/** The leaf the contract appended for one log entry. */
export const logLeaf = (e: UpdateEntry): Hex =>
	keccak256(
		encodeAbiParameters(
			[
				{ type: "bytes32" },
				{ type: "address" },
				{ type: "bytes32" },
				{ type: "uint64" },
				{ type: "bytes32" },
				{ type: "uint64" },
			],
			[
				tag("leaf"),
				e.publisher,
				repoId(e.repo),
				BigInt(e.pos),
				e.head,
				e.timestamp,
			],
		),
	);

/** A mountain range as its length and peaks; `peaks[h]` is live where bit h of n is set. */
export interface Mmr {
	n: number;
	peaks: (Hex | null)[];
}

export const EMPTY_MMR: Mmr = { n: 0, peaks: [] };

export function mmrAppend({ n, peaks }: Mmr, leaf: Hex): Mmr {
	const next = [...peaks];
	let node = leaf;
	let h = 0;
	while ((n >> h) & 1) {
		node = keccak256(
			encodeAbiParameters(
				[{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
				[tag("node"), next[h] ?? zeroHash, node],
			),
		);
		next[h] = null;
		h++;
	}
	next[h] = node;
	return { n: n + 1, peaks: next };
}

/** `logRoot()` for this range. */
export function mmrRoot({ n, peaks }: Mmr): Hex {
	const live: Hex[] = [];
	for (let h = peaks.length - 1; h >= 0; h--)
		if ((n >> h) & 1) live.push(peaks[h] ?? zeroHash);
	return keccak256(
		encodeAbiParameters(
			[{ type: "bytes32" }, { type: "uint64" }, { type: "bytes32[]" }],
			[tag("mmr"), BigInt(n), live],
		),
	);
}
