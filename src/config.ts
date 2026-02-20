import { Chain, Hex } from "viem";
import { arbitrumSepolia, baseSepolia } from "viem/chains";

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
 * @param name "arbitrumSepolia" or "baseSepolia"
 * @returns The corresponding network if it is supported, otherwise an error
 */
export default function getNetwork(name: string) {
	if (name === SupportedNetworks.ArbitrumSepolia.name) return arbitrumSepolia;
	else if (name === SupportedNetworks.BaseSepolia.name) return baseSepolia;

	throw new Error(`Chain ${name} is not supported`);
}

export interface AppConfig {
	// The deployed dataSourceRegistry contract address
	dataSourceRegistryContractAddress: Hex;
	// The name of the chain for LIT action execution (does not always match what is defined by viem)
	chainName: string;
	// The viem chain
	chain: Chain;
	// The public rpc address of the chain we are connecting to
	rpcUrl: string;
	// the caip2 id
	caip2: number;
}

export namespace FangornConfig {
	// Arbitrum Sepolia config
	export const ArbitrumSepolia: AppConfig = {
		// an arbitrum stylus contract
		dataSourceRegistryContractAddress:
			"0x602aedafe1096004d4db591b6537bc39d7ac71a6",
		chainName: "arbitrumSepolia",
		chain: arbitrumSepolia,
		rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
		caip2: 421614,
	};
	// Base Sepolia config
	export const BaseSepolia: AppConfig = {
		dataSourceRegistryContractAddress:
			"0x6fd0e50073dbd8169bcaf066bb4a4991bfa48eeb",
		chainName: "baseSepolia",
		chain: baseSepolia,
		rpcUrl: "https://sepolia.base.org",
		caip2: 84532,
	};
}
