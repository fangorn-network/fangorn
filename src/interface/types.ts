// src/types.ts
export interface VaultEntry {
	tag: string;
	cid: string;
	index: number;
	leaf: string;
	// poseidon1 hash
	commitment: string;
}

export interface VaultManifest {
	version: number;
	poseidon_root: string;
	entries: VaultEntry[];
	tree?: string[][];
}

// For in-memory use before serialization
export interface VaultEntryRaw {
	tag: string;
	cid: string;
	index: number;
	leaf: bigint;
	commitment: string;
}
