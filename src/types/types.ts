export interface VaultEntry {
	tag: string;
	cid: string;
	index: number;
	price: string;
	// leaf: string;
	// commitment: string;
	extension: string;
	fileType: string;
}

export interface VaultManifest {
	// Fangorn internals
	version: number;
	poseidon_root: string;
	entries: VaultEntry[];
	tree?: string[][];
	// ERC-8004 discovery fields
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
		location?: { lat: number; lon: number };
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
		location?: { lat: number; lon: number };
		tags?: string[];
		pricePerRead?: string;
	};
}

export const buildManifest = (options: BuildManifestOptions): VaultManifest => {
	const {
		root,
		entries,
		tree,
		name,
		description,
		vaultId,
		resourceServerEndpoint = "http://localhost:4021/resource",
		metadata,
	} = options;

	return {
		// Fangorn internals
		version: 1,
		poseidon_root: root,
		entries,
		...(tree && { tree }),

		// ERC-8004 discovery fields
		type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
		name,
		description,
		endpoints: [
			{
				name: "fangorn",
				endpoint: resourceServerEndpoint,
				vaultId,
			},
		],
		...(metadata && { metadata }),
	};
};

// intermediate entry struct
export interface PendingEntry {
	tag: string;
	cid: string;
	price: string;
	// leaf: bigint;
	// commitment: Hex;
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
