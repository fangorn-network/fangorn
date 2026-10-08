import { Chain, Hex, keccak256, toHex } from "viem";
import { arbitrumSepolia } from "viem/chains";

/**
 * Derive an app id from a human-readable name (keccak256(hex(name)).
 */
export function appId(name: string): Hex {
	return keccak256(toHex(name));
}

export const DEFAULT_APP = "fangorn";

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
	// The deployed settlement_registry contract address (consumer pay-then-read rail).
	// Superseded by the MembershipRegistry; kept until nothing reads it.
	settlementRegistryContractAddress: Hex;
	// The deployed MembershipRegistry (time-limited, unlinkable access to an app's
	// paid records). Zero until deployed on this network.
	membershipRegistryContractAddress: Hex;
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
		"0x775026e905d7b58b34d16bcbd385fa630ee36c26",
	appRegistryContractAddress:
		"0x11d228c4774af3d9cae3b4b6874a12576a1a83ec",
	settlementRegistryContractAddress:
		"0xbbecb93142d1a5144260d2c30fe3c4a11fdda346",
	// MEMBERSHIP_REGISTRY: set after scripts/deploy-membership.sh
	membershipRegistryContractAddress:
		"0x0000000000000000000000000000000000000000",
	chain: arbitrumSepolia,
	rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
	caip2: 421614,
	ipfsGateway: 'https://ipfs.io'
} satisfies AppConfig
