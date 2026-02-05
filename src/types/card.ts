// an agent card for data sources
export interface FangornDataSourceCard {
	// === ERC-8004 REQUIRED ===
	type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";
	name: string;
	description: string;
	// URL to icon/logo
	image: string;

	// === ERC-8004 ENDPOINTS ===
	endpoints: [
		// Standard A2A discovery (even if minimal)
		{
			name: "A2A";
			// https://prod.fangorn.network/.well-known/agent-card.json
			endpoint: string;
			version: "0.3.0";
		},
		// Payment destination
		{
			name: "agentWallet";
			endpoint: string; // eip155:8453:0x... (CAIP-10 format)
		},
		// Fangorn resource server (custom but discoverable)
		{
			name: "x402f";
			// https://prod.fangorn.network/resource
			endpoint: string;
			version: "1.0.0";
		},
	];

	// === ERC-8004 TRUST === needed?
	supportedTrust: ("reputation" | "crypto-economic" | "tee-attestation")[];

	// === FANGORN EXTENSIONS ===
	extensions: {
		fangorn: {
			vaultId: string;
			// ["payment-settlement", "nft-ownership", ...]
			conditionTypes: string[];
			// "datil" | "datil-dev" | etc
			litNetwork: string;
		};
		x402f?: {
			// pricingModel: "per-query" | "per-byte" | "subscription";
			// "USDC"
			currency: string;
			// optional hint, actual price from endpoint
			basePrice?: string;
		};
		// dataSchema?: {
		//     // "ohlcv" | "social" | "events" | etc
		//     type: string;
		//     // "json" | "csv" | "parquet"
		//     format: string;
		//     // ... domain-specific fields?
		// };
	};
}

export function buildDataSourceCard(
	name: string,
	description: string,
	image: string,
	resourceServerEndpoint: string,
	walletAddress: string,
	chainId: string,
	vaultId: string,
	conditionTypes: string[],
	litNetwork: string,
	// pricingModel: string,
	// dataSchema: string
): FangornDataSourceCard {
	return {
		type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
		name,
		description,
		image: image || "https://fangorn.io/default-datasource-icon.png",

		endpoints: [
			{
				name: "A2A",
				endpoint: `${resourceServerEndpoint}/.well-known/agent-card.json`,
				version: "0.3.0",
			},
			{
				name: "agentWallet",
				endpoint: `eip155:${chainId}:${walletAddress}`,
			},
			{
				name: "x402f",
				endpoint: `${resourceServerEndpoint}/resource`,
				version: "1.0.0",
			},
		],

		// start simple, add more later
		supportedTrust: ["reputation"],

		extensions: {
			fangorn: {
				vaultId,
				conditionTypes: conditionTypes || ["payment-settlement"],
				litNetwork: litNetwork || "datil",
			},
			// ...(pricingModel && {
			//     x402f: {
			//         pricingModel,
			//         currency: "USDC",
			//     },
			// }),
			// ...(dataSchema && { dataSchema }),
		},
	};
}
