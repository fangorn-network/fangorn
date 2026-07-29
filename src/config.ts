import { Chain, Hex, keccak256, toHex } from "viem";
import { arbitrumSepolia, baseSepolia } from "viem/chains";

/**
 * Derive an app id from a human-readable name. Apps claim one of these on-chain
 * with `registerApp`; it prefixes every namespace key the app's publishers write.
 */
export function appId(name: string): Hex {
	return keccak256(toHex(name));
}

/** The app every client publishes under until told otherwise. */
export const DEFAULT_APP = "fangorn";

/**
 * Accept either form callers have on hand: a human-readable app name, or an
 * already-derived app id (32-byte hex), which is what an app owner sees on-chain.
 */
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
	// The viem chain
	chain: Chain;
	// The public rpc address of the chain we are connecting to
	rpcUrl: string;
	// the caip2 id
	caip2: number;
	// A public IPFS gateway that we can read from
	ipfsGateway: string;
}

// Network/deployment settings only. The app id is deliberately NOT here: it is
// per-client state, set with `Fangorn.create({ appId })` and switchable at
// runtime via `fangorn.setAppId(...)` (defaults to `DEFAULT_APP`).
export const FangornConfig = {
	dataRegistryContractAddress:
		"0xdec430f03cdc022ab2338490e9b30ef5c63f7340",
	chain: arbitrumSepolia,
	rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
	caip2: 421614,
	ipfsGateway: 'https://ipfs.io'
} satisfies AppConfig
