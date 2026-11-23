import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { encodeAbiParameters, encodeEventTopics, toHex, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { Fangorn } from "../../fangorn.js";
import { BaseSepoliaConfig } from "../../config.js";
import { UPDATED_V0 } from "./index.js";

// A first catch-up reads one block per old-version entry (they carry no timestamp). Sent all at
// once, a public RPC throttled the burst, and each retry wave was another burst: one 429 killed it.

const BLOCKS = 100;
const PUBLISHER = "0x0000000000000000000000000000000000000001";
const ZERO: Hex = `0x${"00".repeat(32)}`;
const timestampOf = (block: bigint) => block * 2n;

/** An old-version `Updated` log in block `n`, as eth_getLogs returns it. */
const oldLog = (n: number) => ({
	address: BaseSepoliaConfig.dataRegistryContractAddress,
	topics: encodeEventTopics({
		abi: [UPDATED_V0],
		eventName: "Updated",
		args: { publisher: PUBLISHER, repo_id: ZERO },
	}),
	data: encodeAbiParameters(
		[
			{ type: "string" },
			{ type: "uint64" },
			{ type: "bytes32" },
			{ type: "bytes32" },
		],
		["r", BigInt(n), ZERO, `0x${"11".repeat(32)}`],
	),
	blockNumber: toHex(n),
	blockHash: `0x${"33".repeat(32)}`,
	transactionHash: `0x${n.toString(16).padStart(64, "0")}`,
	transactionIndex: "0x0",
	logIndex: "0x0",
	removed: false,
});

/**
 * A JSON-RPC server with BLOCKS old-version log entries, one per block. `refuse(method, n)` says
 * whether to answer the n-th request for `method` with a 429. Counts block reads and how many
 * requests were in flight at once.
 */
async function rpc(refuse: (method: string, n: number) => boolean) {
	const seen = { blockReads: 0, inFlight: 0, maxInFlight: 0 };
	const calls = new Map<string, number>();
	const v0 = encodeEventTopics({ abi: [UPDATED_V0], eventName: "Updated" })[0];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (c: Buffer) => (body += c.toString()));
		req.on("end", () => {
			const { id, method, params } = JSON.parse(body) as {
				id: number;
				method: string;
				params: [{ topics?: Hex[] } | string];
			};
			const n = calls.get(method) ?? 0;
			calls.set(method, n + 1);
			if (method === "eth_getBlockByNumber") seen.blockReads++;
			seen.maxInFlight = Math.max(seen.maxInFlight, ++seen.inFlight);
			setTimeout(() => {
				seen.inFlight--;
				if (refuse(method, n)) {
					res.writeHead(429).end("Request exceeds defined limit.");
					return;
				}
				let result: unknown;
				if (method === "eth_getLogs") {
					const { topics } = params[0] as { topics?: Hex[] };
					result =
						topics?.[0] === v0
							? Array.from({ length: BLOCKS }, (_, i) => oldLog(i + 1))
							: [];
				} else if (method === "eth_getBlockByNumber") {
					const number = params[0] as Hex;
					result = { number, timestamp: toHex(timestampOf(BigInt(number))) };
				} else {
					res.writeHead(400).end(`unexpected ${method}`);
					return;
				}
				res
					.writeHead(200, { "content-type": "application/json" })
					.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
			}, 5);
		});
	});
	await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
	const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
	return { server, url, seen };
}

const registryAt = (url: string, retryCount: number) =>
	Fangorn.create({
		privateKey: generatePrivateKey(),
		config: {
			...BaseSepoliaConfig,
			rpcUrl: url,
			rpcRetry: { retryCount, retryDelay: 1 },
		},
	}).getRegistry();

describe("the update log over a rate-limited RPC", () => {
	let server: Server | undefined;
	afterEach(() => server?.close());

	it("reads old-version timestamps a few at a time, and waits out 429s instead of failing", async () => {
		// the burst of block reads is throttled for a while; a few log reads are refused too
		const r = await rpc((method, n) =>
			method === "eth_getBlockByNumber" ? n < 30 : n < 4,
		);
		server = r.server;
		const entries = await registryAt(r.url, 8).log({}, 1n, BigInt(BLOCKS));
		expect(entries.map((e) => e.timestamp)).toEqual(
			Array.from({ length: BLOCKS }, (_, i) => timestampOf(BigInt(i + 1))),
		);
		expect(r.seen.maxInFlight).toBeLessThanOrEqual(8);
	});

	it("once a block read gives up, sends no more", async () => {
		const r = await rpc((method) => method === "eth_getBlockByNumber");
		server = r.server;
		await expect(
			registryAt(r.url, 1).log({}, 1n, BigInt(BLOCKS)),
		).rejects.toThrow(/429|limit/i);
		await new Promise((ok) => setTimeout(ok, 50)); // let any stragglers arrive
		// each of the 8 readers: one request and one retry, then the queue is dropped
		expect(r.seen.blockReads).toBeLessThanOrEqual(16);
	});
});
