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
	// // The CID pointing to the expected LIT action
	// litActionCid: string;
	// The CID pointing to the compiled circuit json
	// circuitJsonCid: string;
	// The deployed dataSourceRegistry contract address
	dataSourceRegistryContractAddress: Hex;
	// The name of the chain for LIT action execution (does not always match what is defined by viem)
	chainName: string;
	// The viem chain
	chain: Chain;
	// The public rpc address of the chain we are connecting to
	rpcUrl: string;
	// The name of the USDC domain
	// e.g. USDC for base sepolia, USD Coin for Arbitrum
	// usdcDomainName: string;
	// The USDC contract address
	usdcContractAddress: Hex;
	// the caip2 id
	caip2: number;
}

export namespace FangornConfig {
	// Arbitrum Sepolia config
	export const ArbitrumSepolia: AppConfig = {
		usdcContractAddress: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
		// an arbitrum stylus contract
		dataSourceRegistryContractAddress:
			"0x4bd96b4d274bdc845dccd06bb886ecdc0d708bdb",
		chainName: "arbitrumSepolia",
		chain: arbitrumSepolia,
		rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
		// usdcDomainName: "USD Coin",
		caip2: 421614,
	};
	// Base Sepolia config
	export const BaseSepolia: AppConfig = {
		// litActionCid: "QmT5J75W4STgVjEbAUi8i11m9cyKUiZDoPinYf5uTeRfhP",
		usdcContractAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
		dataSourceRegistryContractAddress:
			"0x4e7c79e79da6d98e3747b72147c0bfd9330c95a6",
		chainName: "baseSepolia",
		chain: baseSepolia,
		rpcUrl: "https://sepolia.base.org",
		// usdcDomainName: "USDC",
		caip2: 84532,
	};
}
