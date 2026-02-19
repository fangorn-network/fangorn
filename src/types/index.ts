import { Gadget, GadgetDescriptor } from "../modules/gadgets/types";

export interface VaultEntry {
	tag: string;
	cid: string;
	index: number;
	gadgetDescriptor: GadgetDescriptor;
	extension: string;
	fileType: string;
}

export interface VaultManifest {
	version: number;
	entries: VaultEntry[];
	tree?: string[][];
}

interface BuildManifestOptions {
	root: string;
	entries: VaultEntry[];
	tree?: string[][];
}

export const buildManifest = (options: BuildManifestOptions): VaultManifest => {
	const { root, entries, tree } = options;

	return {
		version: 1,
		entries,
		...(tree && { tree }),
	};
};

// intermediate entry struct
export interface PendingEntry {
	tag: string;
	cid: string;
	gadgetDescriptor: GadgetDescriptor;
	extension: string;
	fileType: string;
}

export interface Filedata {
	tag: string;
	data: string;
	extension: string;
	fileType: string;
}

export interface EncryptedData {
	ciphertext: Uint8Array<ArrayBuffer>;
	iv: Uint8Array<ArrayBuffer>;
	authTag: Uint8Array<ArrayBuffer>;
	salt: Uint8Array<ArrayBuffer>;
}
