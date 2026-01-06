import { poseidon2Hash } from "./utils.js";

const TREE_DEPTH = 8;

export function hashCidToField(cid: string): bigint {
	// Convert CID to field element
	const bytes = new TextEncoder().encode(cid);
	let value = 0n;
	for (let i = 0; i < Math.min(bytes.length, 31); i++) {
		value = (value << 8n) | BigInt(bytes[i]);
	}
	return value;
}

export async function buildTreeFromLeaves(leaves: bigint[]): Promise<{
	root: bigint;
	layers: bigint[][];
}> {
	const size = 2 ** TREE_DEPTH;
	const paddedLeaves = [...leaves];
	while (paddedLeaves.length < size) {
		paddedLeaves.push(0n);
	}

	const layers: bigint[][] = [paddedLeaves];
	let current = paddedLeaves;

	while (current.length > 1) {
		const next: bigint[] = [];
		for (let i = 0; i < current.length; i += 2) {
			const hash = await poseidon2Hash(current[i], current[i + 1]);
			next.push(hash);
		}
		layers.push(next);
		current = next;
	}

	return {
		root: layers[layers.length - 1][0],
		layers,
	};
}

export function getProof(
	layers: bigint[][],
	index: number,
): { path: bigint[]; indices: number[] } {
	const path: bigint[] = [];
	const indices: number[] = [];

	for (let i = 0; i < TREE_DEPTH; i++) {
		const isRight = index % 2 === 1;
		const siblingIndex = isRight ? index - 1 : index + 1;
		path.push(layers[i][siblingIndex] ?? 0n);
		indices.push(isRight ? 1 : 0);
		index = Math.floor(index / 2);
	}

	return { path, indices };
}

export function fieldToHex(field: bigint): `0x${string}` {
	return `0x${field.toString(16).padStart(64, "0")}` as `0x${string}`;
}

export function hexToField(hex: string): bigint {
	const cleanHex = hex.startsWith("0x") ? hex : `0x${hex}`;
	return BigInt(cleanHex);
}
