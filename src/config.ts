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
		"0x97d63259bd91e386322c12fa7e923e5e1c0ddf91",
	appRegistryContractAddress:
		"0xeb1309d4607ffbe2051d296de72d3ca4d2795731",
	subscriptionRegistryContractAddress:
		"0x81681e4f89a24cb46112480f63404fdc35ee4cec",
	settlementRegistryContractAddress:
		"0x480d54411d77820701fd80f42b81fb6e20176d12",
	chain: arbitrumSepolia,
	rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
	caip2: 421614,
	ipfsGateway: 'https://ipfs.io'
} satisfies AppConfig

// =========================================
//  🎉 Deployment complete
// =========================================
// DataRegistry:            0x97d63259bd91e386322c12fa7e923e5e1c0ddf91
// AppRegistry:          0xeb1309d4607ffbe2051d296de72d3ca4d2795731
// Default app "fangorn": 0xe9cb5c7e3e8fb962393e314a9387731152c9b2e3cfb1fcbfe79c0c3038b2ed37
// SubscriptionRegistry:    0x81681e4f89a24cb46112480f63404fdc35ee4cec
// SettlementRegistry:      0x480d54411d77820701fd80f42b81fb6e20176d12
