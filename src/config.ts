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
	// A public IPFS gateway that we can read from
	ipfsGateway: string;
}

export const FangornConfig = {
	// Arbitrum Sepolia config
ArbitrumSepolia: {
		dataSourceRegistryContractAddress: 
			"0xe8a5906825680a5816a7f28f2a0fa2d9ceec3755",
		schemaRegistryContractAddress: 
			"0x267084865813550d9d97d3842c4a2d33a872908f",
		settlementRegistryContractAddress: 
			"0x1d21545f536a2f026348477960ca59f9f1d7fabd",
		chainName: "arbitrumSepolia",
		chain: arbitrumSepolia,
		rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
		caip2: 421614,
		ipfsGateway: 'https://ipfs.io'
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
		ipfsGateway: 'https://ipfs.io'
	} satisfies AppConfig
}
