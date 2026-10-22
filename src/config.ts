import { Chain, Hex, keccak256, toHex } from "viem";
import { arbitrumSepolia, baseSepolia } from "viem/chains";

/**
 * Derive an app id from a human-readable name (keccak256(hex(name)).
 */
export function appId(name: string): Hex {
	return keccak256(toHex(name));
}

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

export interface AppConfig {
	// The deployed DataRegistry (every repo's head, keyed by publisher and repo)
	dataRegistryContractAddress: Hex;
	// The deployed AppRegistry (apps, their subscriptions, membership and exclusions)
	appRegistryContractAddress: Hex;
	// The deployed MembershipRegistry (time-limited, unlinkable access to an app's
	// paid records)
	membershipRegistryContractAddress: Hex;
	// The block the AppRegistry was deployed in. Scans of the registry's logs start here.
	appRegistryFromBlock: bigint;
	// The viem chain
	chain: Chain;
	// The public rpc address of the chain we are connecting to
	rpcUrl: string;
	// the caip2 id
	caip2: number;
	// A public IPFS gateway that we can read from
	ipfsGateway: string;
	// The most blocks one eth_getLogs call may span on `rpcUrl` (default 1000).
	// `FANGORN_LOG_WINDOW` overrides it, for a private RPC.
	logWindow?: bigint;
	// The hosted upload worker gated on this deployment's AppRegistry. Hosted uploads
	// (`storage: { signedUrl: {} }`) go through it unless given a `workerUrl`.
	signedUrlWorker?: string;
}

// Network/deployment settings only. The app is per client:
// `Fangorn.create({ appId })`, switchable with `fangorn.setAppId(...)`.
// Addresses are the proxies in contracts/solidity/script/Deployments.sol.
export const FangornConfig = {
	dataRegistryContractAddress:
		"0x72B5f83526F3893aF9f1eE0f32A27218EA09f8aE",
	appRegistryContractAddress:
		"0x55e6209ea1833ceD900989a3b3b22466934E04A5",
	membershipRegistryContractAddress:
		"0xDF17030Cd65435C86eb043F31DDACa99E819E347",
	appRegistryFromBlock: 319536642n,
	chain: arbitrumSepolia,
	rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
	caip2: 421614,
	ipfsGateway: 'https://ipfs.io',
	// Every scan here is filtered by address; the public RPC served 1M-block ranges
	// of those when measured (2026-10-20).
	logWindow: 100_000n,
	signedUrlWorker: "https://pinata-url-provider.fangorn-0be.workers.dev",
} satisfies AppConfig

export const BaseSepoliaConfig = {
	dataRegistryContractAddress:
		"0xE9183f768865dd2Cde5f1B71F8446F0Cd798ebe0",
	appRegistryContractAddress:
		"0x0D3e98399df41b558048Cdd7D71723c37A3A9D6F",
	membershipRegistryContractAddress:
		"0x0e96C012b5c53622EcDAA82F342E31C2623A04f5",
	appRegistryFromBlock: 48340483n,
	chain: baseSepolia,
	// Not sepolia.base.org: it caps eth_getLogs at 200 blocks, and Base makes 43,200
	// a day, so a scan of the registry's history would be hundreds of calls per day
	// of it. This one caps ranges at 50,000 blocks (measured 2026-10-20).
	rpcUrl: "https://base-sepolia-rpc.publicnode.com",
	caip2: 84532,
	ipfsGateway: 'https://ipfs.io',
	logWindow: 10_000n,
	// Its own worker: the Arbitrum one gates on Arbitrum's AppRegistry, so a Base
	// app's publishers would be refused there.
	signedUrlWorker: "https://pinata-url-provider-base.fangorn-0be.workers.dev",
} satisfies AppConfig

/**
 * The networks supported by Fangorn, by the name `CHAIN_NAME` takes.
 */
export const SupportedNetworks: Record<string, AppConfig> = {
	arbitrumSepolia: FangornConfig,
	baseSepolia: BaseSepoliaConfig,
};

/**
 * Get a network's deployment by name ("arbitrumSepolia" or "baseSepolia").
 * @returns The corresponding config if it is supported, otherwise an error
 */
export default function getNetwork(name: string): AppConfig {
	const config = SupportedNetworks[name] as AppConfig | undefined;
	if (!config) throw new Error(`Chain ${name} is not supported. Use one of: ${Object.keys(SupportedNetworks).join(", ")}`);
	return config;
}
