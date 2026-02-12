import { Hex } from "viem";
import { arbitrumSepolia, baseSepolia } from "viem/chains";

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

export default function getNetwork(name: string) {
	if (name === SupportedNetworks.ArbitrumSepolia.name) return arbitrumSepolia;
	else if (name === SupportedNetworks.BaseSepolia.name) return baseSepolia;

	throw new Error(`Chain ${name} is not supported`);
}

export interface AppConfig {
	// The CID pointing to the expected LIT action
	litActionCid: string;
	// The CID pointing to the compiled circuit json
	// circuitJsonCid: string;
	// The deployed dataSourceRegistry contract address
	dataSourceRegistryContractAddress: Hex;
	// The name of the chain for LIT action execution (does not always match what is defined by viem)
	chainName: string;
	// The public rpc address of the chain we are connecting to
	rpcUrl: string;
	// The name of the USDC domain
	// e.g. USDC for base sepolia, USD Coin for Arbitrum
	usdcDomainName: string;
	// The USDC contract address
	usdcContractAddress: Hex;
}

export namespace FangornConfig {
	// Base Sepolia config
	export const BaseSepolia: AppConfig = {
		litActionCid: "QmeGm5eMurmkfVnnn9Y1rsrLeDeCJLZhgus8cjT339ULPi",
		// circuitJsonCid: "QmXw1rWUC2Kw52Qi55sfW3bCR7jheCDfSUgVRwvsP8ZZPE",
		usdcContractAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
		dataSourceRegistryContractAddress:
			"0xc061f4e1422363a27f1b05bf65b644b29e3cec7c",
		chainName: "baseSepolia",
		rpcUrl: "https://sepolia.base.org",
		usdcDomainName: "USDC",
	};

	// Arbitrum Sepolia config
	export const ArbitrumSepolia: AppConfig = {
		litActionCid: "QmeGm5eMurmkfVnnn9Y1rsrLeDeCJLZhgus8cjT339ULPi",
		// circuitJsonCid: "QmXw1rWUC2Kw52Qi55sfW3bCR7jheCDfSUgVRwvsP8ZZPE",
		usdcContractAddress: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
		dataSourceRegistryContractAddress:
			"0x089bb2fae3daf55950d2168fead4dece4b846984",
		chainName: "arbitrumSepolia",
		rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
		usdcDomainName: "USD Coin",
	};
}
