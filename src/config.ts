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
 * @param name "arbitrumSepolia" is the only one supported right now 
 * @returns The corresponding network if it is supported, otherwise an error
 */
export default function getNetwork(name: string) {
	if (name === SupportedNetworks.ArbitrumSepolia.name) return arbitrumSepolia;
	throw new Error(`Chain ${name} is not supported`);
}

export interface AppConfig {
	// The deployed publisher_registry contract address
	publisherRegistryContractAddress: Hex;
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
	publisherRegistryContractAddress:
		"0x207ab1866704b2adc34e8ec1069fb8febafff2fd",
	chain: arbitrumSepolia,
	rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
	caip2: 421614,
	ipfsGateway: 'https://ipfs.io'
} satisfies AppConfig
