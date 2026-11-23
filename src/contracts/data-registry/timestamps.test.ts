import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { toHex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { Fangorn } from "../../fangorn.js";
import { BaseSepoliaConfig } from "../../config.js";
import type { ChainRegistry, UpdateEntry } from "./index.js";

// A first catch-up reads one block per old-version entry (they carry no timestamp). Sent all at
// once, a public RPC throttled the burst, and each retry wave was another burst: one 429 killed it.

/** A JSON-RPC server that answers eth_getBlockByNumber, refusing with 429 while `refuse()` says so. */
async function rpc(refuse: (n: number) => boolean) {
	const seen = { requests: 0, inFlight: 0, maxInFlight: 0 };
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (c: Buffer) => (body += c.toString()));
		req.on("end", () => {
			const n = seen.requests++;
			seen.maxInFlight = Math.max(seen.maxInFlight, ++seen.inFlight);
			setTimeout(() => {
				seen.inFlight--;
				if (refuse(n)) {
					res.writeHead(429).end("Request exceeds defined limit.");
					return;
				}
				const { id, params } = JSON.parse(body) as {
					id: number;
					params: [string];
				};
				const number = params[0];
				res.writeHead(200, { "content-type": "application/json" }).end(
					JSON.stringify({
						jsonrpc: "2.0",
						id,
						result: { number, timestamp: toHex(BigInt(number) * 2n) },
					}),
				);
			}, 5);
		});
	});
	await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
	const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
	return { server, url, seen };
}

/** Old-version logs, one per block 1..blocks: no `timestamp` in their args. */
const oldLogs = (blocks: number) =>
	Array.from({ length: blocks }, (_, i) => ({
		args: {
			publisher: "0x0000000000000000000000000000000000000001",
			repo_id: `0x${"00".repeat(32)}`,
			repo: "r",
			pos: 1n,
			parent: `0x${"00".repeat(32)}`,
			head: `0x${"11".repeat(32)}`,
		},
		blockNumber: BigInt(i + 1),
		logIndex: 0,
		transactionHash: `0x${"22".repeat(32)}`,
	}));

/** `log`'s timestamp step, on its own (private: `log` reads the logs first). */
const withTimestamps = (r: ChainRegistry, logs: unknown[]) =>
	(
		r as unknown as {
			withTimestamps(logs: unknown[]): Promise<UpdateEntry[]>;
		}
	).withTimestamps(logs);

const registryAt = (url: string, retryCount: number) =>
	Fangorn.create({
		privateKey: generatePrivateKey(),
		config: {
			...BaseSepoliaConfig,
			rpcUrl: url,
			rpcRetry: { retryCount, retryDelay: 1 },
		},
	}).getRegistry() as ChainRegistry;

describe("old-version timestamps over a rate-limited RPC", () => {
	let server: Server | undefined;
	afterEach(() => server?.close());

	it("reads a few at a time, and waits out 429s instead of failing", async () => {
		const r = await rpc((n) => n < 30); // the first 30 requests are refused
		server = r.server;
		const entries = await withTimestamps(registryAt(r.url, 8), oldLogs(100));
		expect(entries.map((e) => e.timestamp)).toEqual(
			Array.from({ length: 100 }, (_, i) => BigInt(i + 1) * 2n),
		);
		expect(r.seen.maxInFlight).toBeLessThanOrEqual(8);
	});

	it("once a read gives up, sends no more", async () => {
		const r = await rpc(() => true);
		server = r.server;
		await expect(
			withTimestamps(registryAt(r.url, 1), oldLogs(100)),
		).rejects.toThrow(/429|limit/i);
		await new Promise((ok) => setTimeout(ok, 50)); // let any stragglers arrive
		// each of the 8 readers: one request and one retry, then the queue is dropped
		expect(r.seen.requests).toBeLessThanOrEqual(16);
	});
});
