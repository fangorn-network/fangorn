/* eslint-disable vitest/no-conditional-expect -- each generated fault decides the expected outcome */
import { describe, expect, it } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import fc from "fast-check";
import {
	WaitForTransactionReceiptTimeoutError,
	zeroAddress,
	type Address,
	type Hash,
	type PublicClient,
	type WalletClient,
} from "viem";
import { baseSepolia } from "viem/chains";
import { APPEND_ALLOWANCE, sendWrite, prepareWrite } from "./write.js";
import { ChainRegistry, ZERO_HEAD, type CommitUpdate } from "./index.js";
import { mintAgent, setAgentFile, retryNonce } from "../erc8004.js";
import { DATA_REGISTRY_ABI } from "./data-registry/abi.js";
import type { Abi } from "viem";

// Fault injection on every write path: sendWrite (DataRegistry update/updateBySig,
// SettlementRegistry) and the ERC-8004 writes. A write may only report success
// when its own transaction mined with status success (or a reprice of it did).

const RUNS = Number(process.env.FUZZ_RUNS ?? 200);
const SEED = 0x5eed;

const REGISTRY = "0x00000000000000000000000000000000000000aa" as Address;
const HASH: Hash = `0x${"11".repeat(32)}`;
const OTHER: Hash = `0x${"22".repeat(32)}`;

const FAULTS = [
	"ok",
	"repriced",
	"reverted",
	"timeout",
	"sendThrows",
	"estimateReverts",
	"receiptRpcError",
	"replaced",
	"cancelled",
] as const;
type Fault = (typeof FAULTS)[number];
const SUCCEEDS: Fault[] = ["ok", "repriced"];

function clients(fault: Fault, logs: unknown[] = []) {
	const sent: Record<string, unknown>[] = [];
	const publicClient = {
		getChainId: () => Promise.resolve(baseSepolia.id),
		estimateFeesPerGas: () =>
			Promise.resolve({ maxFeePerGas: 10n, maxPriorityFeePerGas: 1n }),
		estimateContractGas: () =>
			fault === "estimateReverts"
				? Promise.reject(new Error("execution reverted: StaleStateRoot()"))
				: Promise.resolve(100_000n),
		waitForTransactionReceipt: ({
			hash,
			onReplaced,
		}: {
			hash: Hash;
			onReplaced?: (r: unknown) => void;
		}) => {
			switch (fault) {
				case "timeout":
					return Promise.reject(
						new WaitForTransactionReceiptTimeoutError({ hash }),
					);
				case "receiptRpcError":
					return Promise.reject(new Error("HTTP request failed: 503"));
				case "replaced":
				case "cancelled":
				case "repriced": {
					// viem: it resolves with the REPLACEMENT's receipt.
					const transactionReceipt = {
						status: "success",
						transactionHash: OTHER,
						gasUsed: 1n,
						logs: [],
					};
					onReplaced?.({ reason: fault, transactionReceipt });
					return Promise.resolve(transactionReceipt);
				}
				default:
					return Promise.resolve({
						status: fault === "reverted" ? "reverted" : "success",
						transactionHash: hash,
						gasUsed: 1n,
						logs,
					});
			}
		},
	} as unknown as PublicClient;
	const walletClient = {
		chain: baseSepolia,
		account: { address: "0x00000000000000000000000000000000000000bb" },
		writeContract: (args: Record<string, unknown>) => {
			sent.push(args);
			return fault === "sendThrows"
				? Promise.reject(new Error("socket hang up"))
				: Promise.resolve(HASH);
		},
		signTypedData: () => Promise.resolve("0x"),
	} as unknown as WalletClient;
	return { publicClient, walletClient, sent };
}

const update: CommitUpdate = {
	repo: "r",
	epoch: 1,
	parent: ZERO_HEAD,
	diff: ZERO_HEAD,
	root: ZERO_HEAD,
	car: "0x01",
};

describe("write paths under injected faults", () => {
	it("sendWrite reports success only when its own tx mined successfully", async () => {
		await fc.assert(
			fc.asyncProperty(fc.constantFrom(...FAULTS), async (fault) => {
				const { publicClient, walletClient, sent } = clients(fault);
				const p = sendWrite(
					publicClient,
					walletClient,
					REGISTRY,
					DATA_REGISTRY_ABI as unknown as Abi,
					"update",
					[],
				);
				if (SUCCEEDS.includes(fault)) {
					// A reprice is the same call: report the hash that actually mined.
					expect(await p).toBe(fault === "repriced" ? OTHER : HASH);
					const tx = sent[0];
					expect(tx.gas).toBe((100_000n * 130n) / 100n + APPEND_ALLOWANCE);
					expect(tx.maxFeePerGas).toBe(30n);
				} else {
					await expect(p).rejects.toThrow();
				}
			}),
			{ seed: SEED, numRuns: RUNS },
		);
	});

	it("every DataRegistry write (update, updateBySig) propagates the fault", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(
					fc.record({
						fault: fc.constantFrom(...FAULTS),
						relayed: fc.boolean(),
					}),
					{ minLength: 1, maxLength: 8 },
				),
				async (ops) => {
					for (const { fault, relayed } of ops) {
						const { publicClient, walletClient } = clients(fault);
						const reg = new ChainRegistry(
							{ dataRegistryContractAddress: REGISTRY },
							publicClient,
							walletClient,
						);
						const p = relayed
							? reg.updateBySig(REGISTRY, update, "0x")
							: reg.update(update);
						const ok = await p.then(
							() => true,
							() => false,
						);
						expect(ok).toBe(SUCCEEDS.includes(fault));
					}
				},
			),
			{ seed: SEED, numRuns: Math.ceil(RUNS / 4) },
		);
	});

	it("a timeout says the tx may still land, instead of reading as a clean failure", async () => {
		const { publicClient, walletClient } = clients("timeout");
		await expect(
			new ChainRegistry(
				{ dataRegistryContractAddress: REGISTRY },
				publicClient,
				walletClient,
			).update(update),
		).rejects.toThrow(/may still land/);
	});

	it("a nonce taken by another tx (same key, second process) is not reported as this push", async () => {
		const { publicClient, walletClient } = clients("replaced");
		await expect(
			new ChainRegistry(
				{ dataRegistryContractAddress: REGISTRY },
				publicClient,
				walletClient,
			).update(update),
		).rejects.toThrow(/replaced by tx 0x2222.*did not take effect/);
	});

	it("refuses to write to the zero address (an undeployed network's placeholder)", async () => {
		// Against an address with no code, estimate, send and receipt all succeed.
		const { publicClient, walletClient, sent } = clients("ok");
		const reg = new ChainRegistry(
			{ dataRegistryContractAddress: zeroAddress },
			publicClient,
			walletClient,
		);
		await expect(reg.update(update)).rejects.toThrow(/zero address/);
		await expect(reg.updateBySig(REGISTRY, update, "0x")).rejects.toThrow(
			/zero address/,
		);
		await expect(reg.prepareUpdate(REGISTRY, update)).rejects.toThrow(
			/zero address/,
		);
		await expect(
			prepareWrite(publicClient, REGISTRY, zeroAddress, [], "x", [], {
				fallbackGas: 1n,
			}),
		).rejects.toThrow(/zero address/);
		expect(sent).toHaveLength(0);
	});
});

describe("ERC-8004 writes under injected faults", () => {
	const storage = {
		put: async (file: unknown) =>
			CID.createV1(
				0x55,
				await sha256.digest(new TextEncoder().encode(JSON.stringify(file))),
			).toString(),
	};

	it("rejects an invalid metadata CID before sending a transaction", async () => {
		const { publicClient, walletClient, sent } = clients("ok");
		await expect(
			setAgentFile(
				{
					chain: baseSepolia,
					publicClient,
					walletClient,
					storage: { put: () => Promise.resolve("invalid") },
				},
				1n,
				{},
			),
		).rejects.toThrow();
		expect(sent).toHaveLength(0);
	});

	it("setAgentFile reports success only for its own successful tx", async () => {
		await fc.assert(
			fc.asyncProperty(fc.constantFrom(...FAULTS), async (fault) => {
				// estimateReverts does not apply: these writes don't estimate first.
				fc.pre(fault !== "estimateReverts");
				const { publicClient, walletClient } = clients(fault);
				const ok = await setAgentFile(
					{ chain: baseSepolia, publicClient, walletClient, storage },
					1n,
					{},
				).then(
					() => true,
					() => false,
				);
				expect(ok).toBe(SUCCEEDS.includes(fault));
			}),
			{ seed: SEED, numRuns: RUNS },
		);
	});

	it("mintAgent never returns an id from a failed or foreign tx", async () => {
		await fc.assert(
			fc.asyncProperty(fc.constantFrom(...FAULTS), async (fault) => {
				fc.pre(fault !== "estimateReverts");
				const { publicClient, walletClient } = clients(fault);
				const ok = await mintAgent({
					chain: baseSepolia,
					publicClient,
					walletClient,
					storage,
				}).then(
					() => true,
					() => false,
				);
				// No fault's receipt carries a Registered event, so nothing may succeed.
				expect(ok).toBe(false);
			}),
			{ seed: SEED, numRuns: RUNS },
		);
	});

	it("retryNonce retries only nonce errors, and gives up after `tries`", async () => {
		let calls = 0;
		await expect(
			retryNonce(() => {
				calls++;
				return Promise.reject(new Error("execution reverted"));
			}, 3),
		).rejects.toThrow(/reverted/);
		expect(calls).toBe(1);
	});
});
