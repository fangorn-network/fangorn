import { describe, expect, it, vi } from "vitest";
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { arbitrumSepolia } from "viem/chains";

import { DataRegistryClient, type StateCommittedLog } from "./index.js";

const CONTRACT = "0x9dfa1680e682e0fc79c5904ab453c04c7252572c" as Address;
const APP_ID = ("0x" + "11".repeat(32)) as Hex;
const ACCOUNT = { address: "0x2222222222222222222222222222222222222222" } as const;
const TX = ("0x" + "ab".repeat(32)) as Hex;

/** Clients stubbed down to what `executeWrite` touches. */
function makeClient(status: "success" | "reverted") {
	const publicClient = {
		estimateFeesPerGas: vi.fn(() =>
			Promise.resolve({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
		),
		estimateContractGas: vi.fn(() => Promise.resolve(21_000n)),
		waitForTransactionReceipt: vi.fn(() =>
			Promise.resolve({ status, blockNumber: 7n }),
		),
	} as unknown as PublicClient;
	const walletClient = {
		chain: arbitrumSepolia,
		account: ACCOUNT,
		writeContract: vi.fn(() => Promise.resolve(TX)),
	} as unknown as WalletClient;
	return new DataRegistryClient(CONTRACT, APP_ID, publicClient, walletClient);
}

describe("DataRegistryClient writes", () => {
	it("returns the tx hash when the receipt succeeds", async () => {
		await expect(makeClient("success").registerApp()).resolves.toBe(TX);
	});

	it("throws instead of reporting a reverted tx as a settled one", async () => {
		// A reverted tx still mines, so waitForTransactionReceipt resolves happily —
		// the head never moved, and the caller must not believe it did.
		await expect(
			makeClient("reverted").commitStateRoot("docs", `0x${"0".repeat(64)}`, APP_ID),
		).rejects.toThrow(/commitStateRoot reverted on-chain/);
	});
});

describe("watchStateCommitted", () => {
	it("routes a malformed log to onError instead of throwing into viem", () => {
		let emit: (logs: unknown[]) => void = () => undefined;
		const publicClient = {
			watchContractEvent: vi.fn(
				(args: { onLogs: (logs: unknown[]) => void }) => {
					emit = args.onLogs;
					return () => undefined;
				},
			),
		} as unknown as PublicClient;
		const registry = new DataRegistryClient(
			CONTRACT,
			APP_ID,
			publicClient,
			{ chain: arbitrumSepolia, account: ACCOUNT } as unknown as WalletClient,
		);

		const commits: StateCommittedLog[] = [];
		const errors: Error[] = [];
		registry.watchStateCommitted(
			{},
			(log) => commits.push(log),
			(err) => errors.push(err),
		);

		expect(() => {
			emit([{ args: {}, blockNumber: 1n, transactionHash: TX, logIndex: 0 }]);
		}).not.toThrow();
		expect(commits).toEqual([]);
		expect(errors.map((e) => e.message)).toEqual([
			"Malformed log event: incomplete StateCommitted args",
		]);
	});
});
