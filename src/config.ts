import { Chain, Hex, keccak256, toHex } from "viem";
import { arbitrumSepolia, baseSepolia } from "viem/chains";

/**
 * Derive an app id from a human-readable name (keccak256(hex(name)).
 * Apps are claim one of these on-chain with `AppRegistry.registerApp`
 */
export function appId(name: string): Hex {
	return keccak256(toHex(name));
}

export const DEFAULT_APP = "fangorn";

export function toAppId(nameOrId: string): Hex {
	return /^0x[0-9a-fA-F]{64}$/.test(nameOrId)
		? (nameOrId as Hex)
		: appId(nameOrId);
}

/**
 * The networks supproted by Fangorn currently
 */
export const SupportedNetworks = {
	ArbitrumSepolia: {
		name: "arbitrumSepolia",
		chain: arbitrumSepolia,
	},
	BaseSepolia: {
		name: "baseSepolia",
		chain: baseSepolia,
	},
};

/**
 * Get the network based on the string name
 * @param name "arbitrumSepolia" is the only one supported right now 
 * @returns The corresponding network if it is supported, otherwise an error
 */
export default function getNetwork(name: string) {
	if (name === SupportedNetworks.ArbitrumSepolia.name) return arbitrumSepolia;
	throw new Error(`Chain ${name} is not supported`);
}

export interface AppConfig {
	// The deployed publisher_registry contract address
	dataRegistryContractAddress: Hex;
	// The deployed app_registry contract address
	appRegistryContractAddress: Hex;
	// The deployed subscription_registry contract address (publisher storage paywall)
	subscriptionRegistryContractAddress: Hex;
	// The deployed settlement_registry contract address (consumer pay-then-read rail)
	settlementRegistryContractAddress: Hex;
	// The viem chain
	chain: Chain;
	// The public rpc address of the chain we are connecting to
	rpcUrl: string;
	// the caip2 id
	caip2: number;
	// A public IPFS gateway that we can read from
	ipfsGateway: string;
}

// Network/deployment settings only
// set with `Fangorn.create({ appId })` and switchable at
// runtime via `fangorn.setAppId(...)` (defaults to `DEFAULT_APP`).
export const FangornConfig = {
	dataRegistryContractAddress:
		"0x3b0cf19bef492500401e4d74e6fa29a56d0cc67b",
	appRegistryContractAddress:
		"0xcc92f3d827df33be7323eef28e67a509034f5a59",
	subscriptionRegistryContractAddress:
		"0xe82192be4c20d3dc93fbc63e3ecd7e13c3889726",
	settlementRegistryContractAddress:
		"0x47a2a0d7e7fc8a044f6d6f1d878c4178952ea779",
	chain: arbitrumSepolia,
	rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
	caip2: 421614,
	ipfsGateway: 'https://ipfs.io'
} satisfies AppConfig

// DataRegistry:            0x3b0cf19bef492500401e4d74e6fa29a56d0cc67b
// AppRegistry:          0xcc92f3d827df33be7323eef28e67a509034f5a59
// Default app "fangorn": 0xe9cb5c7e3e8fb962393e314a9387731152c9b2e3cfb1fcbfe79c0c3038b2ed37
// SubscriptionRegistry:    0xe82192be4c20d3dc93fbc63e3ecd7e13c3889726
// SettlementRegistry:      0x47a2a0d7e7fc8a044f6d6f1d878c4178952ea779
