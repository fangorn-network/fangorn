export declare function hashCidToField(cid: string): bigint;
export declare function buildTreeFromLeaves(leaves: bigint[]): Promise<{
	root: bigint;
	layers: bigint[][];
}>;
export declare function getProof(
	layers: bigint[][],
	index: number,
): {
	path: bigint[];
	indices: number[];
};
export declare function fieldToHex(field: bigint): `0x${string}`;
export declare function hexToField(hex: string): bigint;
