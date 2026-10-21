// ERC-8004 registration for `fangorn app agent`. 
// It builds a registration file that gets pinned to IPFS, 
// and handles the identity registry's `register` and `setAgentURI` functions.
// 
// The file is identitcal agent0-sdk's format, so the
// agents it minted and the ones minted here read the same to 8004scan.
//

import {
	parseAbi,
	parseEventLogs,
	type Address,
	type Chain,
	type Hex,
	type PublicClient,
	type WalletClient,
} from "viem";
import { PinataSDK } from "pinata";

/** The ERC-8004 identity registry by chain id */
export const IDENTITY_REGISTRY: Record<number, Address> = {
	// Base Sepolia
	84532: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
	// Arbitrum Sepolia (TODO: remove?)
	421614: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
};

const ABI = parseAbi([
	"function register(string agentURI, (string metadataKey, bytes metadataValue)[] metadata) returns (uint256 agentId)",
	"function setAgentURI(uint256 agentId, string newURI)",
	"event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
]);

export interface AgentCard {
	name: string;
	description: string;
	skills?: { tags?: unknown }[];
}

interface Service {
	name: "A2A" | "MCP";
	endpoint: string;
	version: string;
	a2aSkills?: string[];
	mcpTools?: string[];
}

/**
 * Get the agent card URL based on the access worker if defined, else return the carUrl
 * Both params are optional, but at least one must be defined.
 * 
 * Agent cards must live at accessWorker/.well-known/agent-card.json
 * 
 * @param cardUrl The cardUrl (passthrough when defined)
 * @param accessWorker The (optional) access worker url 
 * @returns 
 */
export function agentCardUrl(cardUrl?: string, accessWorker?: string): string {
	if (cardUrl) return cardUrl;
	if (!accessWorker) throw new Error("No card URL. Pass one, or pass --access-worker <url>.");
	return `${accessWorker.replace(/\/$/, "")}/.well-known/agent-card.json`;
}

export async function mcpTools(
	endpoint: string,
): Promise<string[] | undefined> {
	try {
		const res = await fetch(endpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) return undefined;
		const text = await res.text();
		// streamable-HTTP server => could be a single SSE event
		const body =
			text
				.split("\n")
				.find((l) => l.startsWith("data: "))
				?.slice(6) ?? text;
		const tools =
			(JSON.parse(body) as { result?: { tools?: { name?: unknown }[] } }).result
				?.tools ?? [];
		const names = tools
			.map((t) => t.name)
			.filter((n): n is string => typeof n === "string");
		return names.length ? names : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Build a registration file 
 * Since it desfines its own agent id, 
 * first registration mints without an agent URI and must be set retroactively.
 */
export function registrationFile(opts: {
	cardUrl: string;
	card: AgentCard;
	chainId: number;
	agentId: bigint;
	mcp?: { endpoint: string; tools?: string[] };
	now?: number;
}): Record<string, unknown> {
	const { cardUrl, card, chainId, agentId, mcp } = opts;
	const tags = [
		...new Set(
			(card.skills ?? [])
				.flatMap((s) => (Array.isArray(s.tags) ? (s.tags as unknown[]) : []))
				.filter((t): t is string => typeof t === "string"),
		),
	];
	const services: Service[] = [
		{
			name: "A2A",
			endpoint: cardUrl,
			version: "0.30",
			...(tags.length && { a2aSkills: tags }),
		},
	];
	if (mcp)
		services.push({
			name: "MCP",
			endpoint: mcp.endpoint,
			version: "2025-06-18",
			...(mcp.tools && { mcpTools: mcp.tools }),
		});
	return {
		type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
		name: card.name,
		description: card.description,
		services,
		registrations: [
			{
				agentId: Number(agentId),
				agentRegistry: `eip155:${String(chainId)}:${IDENTITY_REGISTRY[chainId]}`,
			},
		],
		// Reputation only, no TEE support
		supportedTrust: ["reputation"],
		active: true,
		// only set x402 support true if the card says so
		x402Support:
			card.skills?.some(
				(s) => Array.isArray(s.tags) && s.tags.includes("x402"),
			) ?? false,
		updatedAt: opts.now ?? Math.floor(Date.now() / 1000),
	};
}

/** `84532:10323` or `10323` → the token id, refusing an agent on another chain. */
export function parseAgentId(id: string, chainId: number): bigint {
	const m = /^(?:(\d+):)?(\d+)$/.exec(id.trim());
	if (!m)
		throw new Error(
			`not an agent id: ${JSON.stringify(id)} (expected <chainId>:<tokenId>, e.g. 84532:10323)`,
		);
	if (m[1] && Number(m[1]) !== chainId) {
		throw new Error(
			`agent ${id} is on chain ${m[1]}, but the CLI is configured for ${String(chainId)}`,
		);
	}
	return BigInt(m[2]);
}

export interface Erc8004Clients {
	chain: Chain;
	publicClient: PublicClient;
	walletClient: WalletClient;
	pinataJwt: string;
}

async function pin(jwt: string, data: unknown): Promise<string> {
	const file = new File(
		[JSON.stringify(data, null, 2)],
		"agent-registration.json",
		{ type: "application/json" },
	);
	return (await new PinataSDK({ pinataJwt: jwt }).upload.public.file(file)).cid;
}

function registry(chain: Chain): Address {
	const address = IDENTITY_REGISTRY[chain.id] as Address | undefined;
	if (!address)
		throw new Error(
			`no ERC-8004 identity registry known for chain ${String(chain.id)}`,
		);
	return address;
}

/** Pin `file` and point agent `agentId` at it. */
export async function setAgentFile(
	c: Erc8004Clients,
	agentId: bigint,
	file: unknown,
): Promise<Hex> {
	const cid = await pin(c.pinataJwt, file);
	const hash = await c.walletClient.writeContract({
		address: registry(c.chain),
		abi: ABI,
		functionName: "setAgentURI",
		args: [agentId, `ipfs://${cid}`],
		chain: c.chain,
		account: c.walletClient.account ?? null,
	});
	await c.publicClient.waitForTransactionReceipt({ hash });
	return hash;
}

/** Mint an agent with no URI yet, and return its id. */
export async function mintAgent(c: Erc8004Clients): Promise<bigint> {
	const address = registry(c.chain);
	const hash = await c.walletClient.writeContract({
		address,
		abi: ABI,
		functionName: "register",
		args: ["", []],
		chain: c.chain,
		account: c.walletClient.account ?? null,
	});
	const receipt = await c.publicClient.waitForTransactionReceipt({ hash });
	const minted = parseEventLogs({
		abi: ABI,
		eventName: "Registered",
		logs: receipt.logs,
	}).find((l) => l.address.toLowerCase() === address.toLowerCase());
	if (!minted)
		throw new Error(`register ${hash} confirmed with no Registered event`);
	return minted.args.agentId;
}
