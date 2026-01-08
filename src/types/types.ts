import { Hex } from "viem";

// src/types.ts
export interface VaultEntry {
	tag: string;
	cid: string;
	index: number;
	leaf: string;
	commitment: string;
	extension: string;
	fileType: string;
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
	extension: string;
	fileType: string;
}

// intermediate entry struct
export interface PendingEntry {
	tag: string;
	cid: string;
	leaf: bigint;
	commitment: Hex;
	acc: any;
	extension: string;
	fileType: string;
}

// TODO add to types.ts
export interface Filedata {
	tag: string;
	data: string;
	extension: string;
	fileType: string;
}
