/* eslint-disable vitest/no-conditional-expect -- generated ranges decide the expected calls */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
	createPublicClient,
	custom,
	encodeAbiParameters,
	encodeEventTopics,
	keccak256,
	stringToHex,
	toHex,
	type AbiEvent,
	type Address,
	type Hash,
	type Hex,
	type PublicClient,
} from "viem";
import { getLogsInWindows } from "./logs.js";
import {
	ChainRegistry,
	DATA_REGISTRY_ABI,
	UPDATED_V0,
	logLeaf,
	type UpdateEntry,
} from "./index.js";

// Log scanning and watching on the chain registry: window arithmetic at block
// boundaries, ordering by (blockNumber, logIndex) whatever order the node answers
// in, in-order delivery of live batches, and reorg-removed logs.

const RUNS = Number(process.env.FUZZ_RUNS ?? 200);
const SEED = 0x1095;
const REGISTRY = "0x00000000000000000000000000000000000000aa" as Address;
const PUBLISHER = "0x00000000000000000000000000000000000000bb" as Address;

interface FakeLog {
	eventName: string;
	args: {
		publisher: Address;
		repo: string;
		pos: bigint;
		parent: Hash;
		head: Hash;
	};
	blockNumber: bigint;
	logIndex: number;
	transactionHash: Hash;
	removed?: boolean;
}

const fakeLog = (
	block: bigint,
	logIndex: number,
	removed = false,
): FakeLog => ({
	// viem's decoded logs carry it; watch() keeps only "Updated"
	eventName: "Updated",
	args: {
		publisher: PUBLISHER,
		repo: "r",
		pos: 1n,
		parent: `0x${"00".repeat(32)}`,
		head: `0x${block.toString(16).padStart(32, "0")}${logIndex.toString(16).padStart(32, "0")}`,
	},
	blockNumber: block,
	logIndex,
	transactionHash: `0x${block.toString(16).padStart(64, "0")}`,
	removed,
});

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("getLogsInWindows", () => {
	it("covers [from, to] exactly once in contiguous windows no wider than asked", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.bigInt({ min: 0n, max: 10_000n }),
				fc.bigInt({ min: -5n, max: 5_000n }),
				fc.bigInt({ min: 1n, max: 2_000n }),
				async (from, span, window) => {
					const to = from + span;
					const calls: [bigint, bigint][] = [];
					await getLogsInWindows(
						{} as PublicClient,
						from,
						to,
						(a, b) => {
							calls.push([a, b]);
							return Promise.resolve([]);
						},
						window,
					);
					if (to < from) {
						expect(calls).toEqual([]);
						return;
					}
					expect(calls[0][0]).toBe(from);
					expect(calls.at(-1)?.[1]).toBe(to);
					for (let i = 0; i < calls.length; i++) {
						const [a, b] = calls[i];
						expect(a <= b).toBe(true);
						expect(b - a + 1n <= window).toBe(true);
						if (i > 0) expect(a).toBe(calls[i - 1][1] + 1n);
					}
				},
			),
			{ seed: SEED, numRuns: RUNS },
		);
	});
});

describe("ChainRegistry.log", () => {
	it("returns every log once, ordered by (block, logIndex), whatever order windows answer in", async () => {
		await fc.assert(
			fc.asyncProperty(
				// logs per block in 0..40, up to 4 per block
				fc.uniqueArray(
					fc.tuple(fc.bigInt({ min: 0n, max: 40n }), fc.nat({ max: 3 })),
					{ selector: ([b, i]) => `${String(b)}:${String(i)}`, maxLength: 30 },
				),
				fc.bigInt({ min: 1n, max: 9n }),
				fc.infiniteStream(fc.nat()),
				async (keys, window, rand) => {
					const all = keys.map(([b, i]) => fakeLog(b, i));
					const publicClient = {
						getContractEvents: ({
							abi,
							fromBlock,
							toBlock,
						}: {
							abi: AbiEvent[];
							fromBlock: bigint;
							toBlock: bigint;
						}) => {
							// these are all new-version logs; the old-version query finds none
							if (abi[0] === UPDATED_V0) return Promise.resolve([]);
							const inRange = all.filter(
								(l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock,
							);
							// the node's order within a window is arbitrary
							const r = rand.next().value;
							return Promise.resolve(
								inRange.sort(() => ((r >> inRange.length) & 1 ? 1 : -1)),
							);
						},
						getBlock: ({ blockNumber }: { blockNumber: bigint }) =>
							Promise.resolve({ timestamp: blockNumber * 2n }),
						getBlockNumber: () => Promise.resolve(40n),
					} as unknown as PublicClient;
					const reg = new ChainRegistry(
						{ dataRegistryContractAddress: REGISTRY, logWindow: window },
						publicClient,
					);
					const got = await reg.log({}, 0n);
					const want = [...all].sort((a, b) =>
						a.blockNumber === b.blockNumber
							? a.logIndex - b.logIndex
							: a.blockNumber < b.blockNumber
								? -1
								: 1,
					);
					expect(got.map((e) => e.id)).toEqual(
						want.map((l) => `${l.transactionHash}:${String(l.logIndex)}`),
					);
					expect(new Set(got.map((e) => e.id)).size).toBe(got.length);
					for (const e of got) expect(e.timestamp).toBe(e.t * 2n);
				},
			),
			{ seed: SEED, numRuns: RUNS },
		);
	});
});

describe("ChainRegistry.watch", () => {
	it("delivers live batches in order even when block reads resolve out of order, and skips reorg-removed logs", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(
					fc.array(
						fc.record({ removed: fc.boolean(), lag: fc.nat({ max: 3 }) }),
						{
							minLength: 1,
							maxLength: 4,
						},
					),
					{ maxLength: 5 },
				),
				async (batches) => {
					let onLogs!: (logs: FakeLog[]) => void;
					const lagOf = new Map<bigint, number>();
					const publicClient = {
						watchContractEvent: (opts: {
							onLogs: (logs: FakeLog[]) => void;
						}) => {
							onLogs = opts.onLogs;
							return () => undefined;
						},
						getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
							await delay(lagOf.get(blockNumber) ?? 0);
							return { timestamp: blockNumber };
						},
					} as unknown as PublicClient;
					const reg = new ChainRegistry(
						{ dataRegistryContractAddress: REGISTRY },
						publicClient,
					);
					const got: UpdateEntry[] = [];
					const errors: Error[] = [];
					reg.watch(
						{},
						(e) => got.push(e),
						(e) => errors.push(e),
					);

					let block = 0n;
					const want: string[] = [];
					for (const batch of batches) {
						const logs = batch.map(({ removed, lag }) => {
							block++;
							// later blocks resolve first
							lagOf.set(block, 3 - lag);
							const l = fakeLog(block, 0, removed);
							if (!removed) want.push(`${l.transactionHash}:0`);
							return l;
						});
						onLogs(logs);
					}
					await delay(20);
					expect(errors).toEqual([]);
					expect(got.map((e) => e.id)).toEqual(want);
				},
			),
			{ seed: SEED, numRuns: Math.ceil(RUNS / 4) },
		);
	});
});

describe("ChainRegistry reads both versions of `Updated`", () => {
	// The proxy is upgraded in place: history before the upgrade has the old topic
	// (no index/timestamp), after it the new one.
	it("decodes old and new logs through a real viem client, timestamps from block or event", async () => {
		const updated = DATA_REGISTRY_ABI.find(
			(i) => i.type === "event" && i.name === "Updated",
		) as AbiEvent;
		const repo_id = keccak256(toHex("r"));
		const head = (n: number): Hash => `0x${n.toString(16).padStart(64, "0")}`;
		const encode = (ev: AbiEvent, block: number, extra: unknown[]) => ({
			address: REGISTRY,
			topics: encodeEventTopics({
				abi: [ev],
				eventName: "Updated",
				args: { publisher: PUBLISHER, repo_id },
			} as never),
			data: encodeAbiParameters(
				ev.inputs.filter((i) => !i.indexed),
				["r", BigInt(block), head(0), head(block), ...extra],
			),
			blockNumber: toHex(block),
			logIndex: "0x0",
			transactionIndex: "0x0",
			transactionHash: head(1000 + block),
			blockHash: head(2000 + block),
			removed: false,
		});
		const logs = [encode(UPDATED_V0, 5, []), encode(updated, 7, [1n, 777n])];
		const blockReads: bigint[] = [];
		const client = createPublicClient({
			transport: custom({
				request: ({
					method,
					params,
				}: {
					method: string;
					params: unknown[];
				}) => {
					if (method === "eth_blockNumber") return Promise.resolve("0xa");
					if (method === "eth_getLogs") {
						const { topics } = params[0] as { topics: (Hex | null)[] };
						return Promise.resolve(
							logs.filter((l) => l.topics[0] === topics[0]),
						);
					}
					if (method === "eth_getBlockByNumber") {
						const n = BigInt(params[0] as string);
						blockReads.push(n);
						return Promise.resolve({
							number: toHex(n),
							hash: head(2000 + Number(n)),
							timestamp: toHex(n * 100n),
							transactions: [],
						});
					}
					return Promise.reject(new Error(`unexpected ${method}`));
				},
			}),
		}) as PublicClient;
		const reg = new ChainRegistry(
			{ dataRegistryContractAddress: REGISTRY },
			client,
		);
		const got = await reg.log({ repo: "r" }, 0n);
		expect(got.map((e) => [e.t, e.pos, e.head, e.timestamp])).toEqual([
			[5n, 5, head(5), 500n], // old: its block's timestamp
			[7n, 7, head(7), 777n], // new: the event's own
		]);
		expect(blockReads).toEqual([5n]);
		expect(got.every((e) => e.repoId === repo_id)).toBe(true);
	});
});

describe("ChainRegistry entries carry the event's repo_id", () => {
	// The contract hashes the repo's raw bytes; a non-UTF-8 name decodes to U+FFFD and
	// re-hashes to another id, so the log leaf must use the indexed repo_id.
	it("a non-UTF-8 repo name still yields the contract's leaf", async () => {
		const rawName: Hex = "0x61ff"; // "a\xff"
		const repo_id = keccak256(rawName);
		const updated = DATA_REGISTRY_ABI.find(
			(i) => i.type === "event" && i.name === "Updated",
		) as AbiEvent;
		const log = {
			address: REGISTRY,
			topics: encodeEventTopics({
				abi: [updated],
				eventName: "Updated",
				args: { publisher: PUBLISHER, repo_id },
			} as never),
			// `bytes` encodes exactly like `string`, minus the UTF-8 assumption
			data: encodeAbiParameters(
				[
					{ type: "bytes" },
					{ type: "uint64" },
					{ type: "bytes32" },
					{ type: "bytes32" },
					{ type: "uint64" },
					{ type: "uint64" },
				],
				[rawName, 1n, `0x${"00".repeat(32)}`, `0x${"11".repeat(32)}`, 0n, 9n],
			),
			blockNumber: "0x1",
			logIndex: "0x0",
			transactionIndex: "0x0",
			transactionHash: `0x${"22".repeat(32)}`,
			blockHash: `0x${"33".repeat(32)}`,
			removed: false,
		};
		const client = createPublicClient({
			transport: custom({
				request: ({
					method,
					params,
				}: {
					method: string;
					params: unknown[];
				}) => {
					if (method === "eth_getLogs") {
						const { topics } = params[0] as { topics: (Hex | null)[] };
						return Promise.resolve(topics[0] === log.topics[0] ? [log] : []);
					}
					return Promise.reject(new Error(`unexpected ${method}`));
				},
			}),
		}) as PublicClient;
		const [e] = await new ChainRegistry(
			{ dataRegistryContractAddress: REGISTRY },
			client,
		).log({}, 0n, 1n);
		expect(e.repo).toBe("a�");
		expect(e.repoId).toBe(repo_id);
		expect(logLeaf(e)).toBe(
			keccak256(
				encodeAbiParameters(
					[
						{ type: "bytes32" },
						{ type: "address" },
						{ type: "bytes32" },
						{ type: "uint64" },
						{ type: "bytes32" },
						{ type: "uint64" },
					],
					[
						stringToHex("leaf", { size: 32 }),
						PUBLISHER,
						repo_id,
						1n,
						`0x${"11".repeat(32)}`,
						9n,
					],
				),
			),
		);
	});
});
