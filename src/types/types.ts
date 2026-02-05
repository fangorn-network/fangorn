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

// an agent card for data sources
interface FangornDataSourceCard {
	// === ERC-8004 REQUIRED ===
	type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";
	name: string;
	description: string;
	image: string; // URL to icon/logo

	// === ERC-8004 ENDPOINTS ===
	endpoints: [
		// Standard A2A discovery (even if minimal)
		{
			name: "A2A";
			endpoint: string; // https://example.com/.well-known/agent-card.json
			version: "0.3.0";
		},
		// Payment destination
		{
			name: "agentWallet";
			endpoint: string; // eip155:8453:0x... (CAIP-10 format)
		},
		// Fangorn resource server (custom but discoverable)
		{
			name: "x402f"; // or "fangorn" - see note below
			endpoint: string; // https://example.com/resource
			version: "1.0.0";
		},
	];

	// === ERC-8004 TRUST ===
	supportedTrust: ("reputation" | "crypto-economic" | "tee-attestation")[];

	// === FANGORN EXTENSIONS ===
	extensions: {
		fangorn: {
			vaultId: string;
			conditionTypes: string[]; // ["payment-settlement", "nft-ownership", ...]
			litNetwork: string; // "datil" | "datil-dev" | etc
		};
		x402f?: {
			pricingModel: "per-query" | "per-byte" | "subscription";
			currency: string; // "USDC"
			basePrice?: string; // optional hint, actual price from endpoint
		};
		dataSchema?: {
			type: string; // "ohlcv" | "social" | "events" | etc
			format: string; // "json" | "csv" | "parquet"
			// ... domain-specific fields
		};
	};
}

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
