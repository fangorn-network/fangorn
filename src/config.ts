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
	// The deployed schemaRegistry contract address
	schemaRegistryContractAddress: Hex;
	// The deployed settlementRegistry contract adddress
	settlementRegistryContractAddress: Hex;
	// The name of the chain for LIT action execution (does not always match what is defined by viem)
	chainName: string;
	// The viem chain
	chain: Chain;
	// The public rpc address of the chain we are connecting to
	rpcUrl: string;
	// the caip2 id
	caip2: number;
}

export const FangornConfig = {
	// Arbitrum Sepolia config
	ArbitrumSepolia: {
		dataSourceRegistryContractAddress:
			"0xddd338e6a200012642a103c6631ea92eea94cabe",
		schemaRegistryContractAddress: "0xef6754c29cfd0c8937a080695899f2a9a23c7c70",
		settlementRegistryContractAddress: "0x5e918ba3fe33b0bdc68cd46eb6a77db754edef57",
		chainName: "arbitrumSepolia",
		chain: arbitrumSepolia,
		rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
		caip2: 421614,
	} satisfies AppConfig,
	// Base Sepolia config (incomplete :| do not use)
	BaseSepolia: {
		dataSourceRegistryContractAddress:
			"0x6fd0e50073dbd8169bcaf066bb4a4991bfa48eeb",
		// TODO
		schemaRegistryContractAddress: "0x0",
		settlementRegistryContractAddress: "0x0",
		chainName: "baseSepolia",
		chain: baseSepolia,
		rpcUrl: "https://sepolia.base.org",
		caip2: 84532,
	} satisfies AppConfig
}
