import { Chain, Hex } from "viem";
import { baseSepolia } from "viem/chains";

/**
 * Blank input means "not set", never a value of "". Returns the trimmed value,
 * or undefined when it is missing or only whitespace, so it can sit on the left of
 * a `??` fallback. `??` on the raw value would let "" through: it is not nullish.
 */
export function nonBlank(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed === "" ? undefined : trimmed;
}

export interface NetworkConfig {
	// The deployed DataRegistry (every repo's head, keyed by publisher and repo)
	dataRegistryContractAddress: Hex;
	// The deployed SettlementRegistry (per-record prices, referral splits, read access).
	// Unset where it is not deployed.
	settlementRegistryContractAddress?: Hex;
	// The block the DataRegistry was deployed in. Scans of its update log start here.
	fromBlock: bigint;
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
	// The hosted upload worker for this network. Hosted uploads
	// (`storage: { signedUrl: {} }`) go through it unless given a `workerUrl`.
	signedUrlWorker?: string;
}

// Network/deployment settings only. Addresses are the proxies in contracts/solidity/script/Deployments.sol.
export const BaseSepoliaConfig = {
	dataRegistryContractAddress: "0x0F3eb0E62CF610dbaC6B3aD4Bf4cE38Ab50EBCC5",
	settlementRegistryContractAddress:
		"0x61A5A195B54F57ada786Ba6689CdB04553cf7fBc",
	fromBlock: 53592845n,
	chain: baseSepolia,
	// Not sepolia.base.org: it caps eth_getLogs at 200 blocks, and Base makes 43,200
	// a day, so a scan of the registry's history would be hundreds of calls per day
	// of it. This one caps ranges at 50,000 blocks (measured 2026-10-20).
	rpcUrl: "https://base-sepolia-rpc.publicnode.com",
	caip2: 84532,
	ipfsGateway: "https://ipfs.io",
	logWindow: 1_000n,
	signedUrlWorker: "https://base-sepolia.storage-worker.fangorn.network",
} satisfies NetworkConfig;

/**
 * The default network: what `Fangorn.create` uses without a `config`, and the CLI
 * without `CHAIN_NAME`. Base Sepolia, which runs the contracts this SDK's ABIs are
 * built from.
 */
export const FangornConfig = BaseSepoliaConfig;

/**
 * The networks supported by Fangorn, by the name `CHAIN_NAME` takes.
 */
export const SupportedNetworks: Record<string, NetworkConfig> = {
	baseSepolia: BaseSepoliaConfig,
};

/**
 * Get a network's deployment by name ("baseSepolia").
 * @returns The corresponding config if it is supported, otherwise an error
 */
export default function getNetwork(name: string): NetworkConfig {
	const config = SupportedNetworks[name] as NetworkConfig | undefined;
	if (!config)
		throw new Error(
			`Chain ${name} is not supported. Use one of: ${Object.keys(SupportedNetworks).join(", ")}`,
		);
	return config;
}
