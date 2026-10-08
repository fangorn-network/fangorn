import { Chain, Hex, keccak256, toHex } from "viem";
import { arbitrumSepolia } from "viem/chains";

/**
 * Derive an app id from a human-readable name (keccak256(hex(name)).
 */
export function appId(name: string): Hex {
	return keccak256(toHex(name));
}

export const DEFAULT_APP = "fangorn";

/**
 * Blank input means "not set", never an app called "". Returns the trimmed value,
 * or undefined when it is missing or only whitespace, so it can sit on the left of
 * a `??` fallback. `??` on the raw value would let "" through: it is not nullish.
 */
export function nonBlank(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed === "" ? undefined : trimmed;
}

export function toAppId(nameOrId: string): Hex {
	// A blank name hashes to keccak("") — a valid-looking id for an app nobody
	// owns. Callers normalise blank to "unset" at their input boundary; anything
	// that gets here blank is a bug, so say so instead of publishing into a
	// phantom app (and billing the wrong subscription).
	const name = nameOrId.trim();
	if (!name) throw new Error("App name or id must not be blank.");
	return /^0x[0-9a-fA-F]{64}$/.test(name) ? (name as Hex) : appId(name);
}

/**
 * The networks supported by Fangorn currently
 */
export const SupportedNetworks = {
	ArbitrumSepolia: {
		name: "arbitrumSepolia",
		chain: arbitrumSepolia,
	}
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
	// The deployed app_registry contract address (apps, membership, and the
	// per-app storage subscription)
	appRegistryContractAddress: Hex;
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
		"0x0312503913656f25c2bfDf229425aA6926ccF1Cd",
	appRegistryContractAddress:
		"0x57b41E334864B430db44F7FbCD8d165C56e41402",
	settlementRegistryContractAddress:
		"0x281580BDc478393857955EE61b6F05dB4A29d887",
	chain: arbitrumSepolia,
	rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
	caip2: 421614,
	ipfsGateway: 'https://ipfs.io'
} satisfies AppConfig
