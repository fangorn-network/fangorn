export interface VaultEntry {
	tag: string;
	cid: string;
	index: number;
	price: string;
	extension: string;
	fileType: string;
}
export interface VaultManifest {
	version: number;
	poseidon_root: string;
	entries: VaultEntry[];
	tree?: string[][];
	type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";
	name: string;
	description: string;
	endpoints: [
		{
			name: "fangorn";
			endpoint: string;
			vaultId: string;
		},
	];
	metadata?: {
		location?: {
			lat: number;
			lon: number;
		};
		tags?: string[];
		pricePerRead?: string;
	};
}
interface BuildManifestOptions {
	root: string;
	entries: VaultEntry[];
	tree?: string[][];
	name: string;
	description: string;
	vaultId: string;
	resourceServerEndpoint?: string;
	metadata?: {
		location?: {
			lat: number;
			lon: number;
		};
		tags?: string[];
		pricePerRead?: string;
	};
}
export declare const buildManifest: (
	options: BuildManifestOptions,
) => VaultManifest;
export interface PendingEntry {
	tag: string;
	cid: string;
	price: string;
	acc: any;
	extension: string;
	fileType: string;
}
export interface Filedata {
	tag: string;
	data: string;
	extension: string;
	fileType: string;
	price: string;
}
export interface EncryptedData {
	ciphertext: Uint8Array<ArrayBuffer>;
	iv: Uint8Array<ArrayBuffer>;
	authTag: Uint8Array<ArrayBuffer>;
	salt: Uint8Array<ArrayBuffer>;
}
export {};
