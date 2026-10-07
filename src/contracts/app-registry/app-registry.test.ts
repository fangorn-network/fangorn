import { describe, it, expect } from "vitest";
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { AppRegistryClient } from "./index.js";
import { PublisherStatus } from "../types.js";

// Claiming an app pulls the subscription fee with transferFrom, and joining one
// needs the owner's invitation. Both are checked client-side so the caller gets
// a reason instead of a bare revert.

const REGISTRY = "0x00000000000000000000000000000000000000aa" as Address;
const USDC = "0x00000000000000000000000000000000000000bb" as Address;
const SELF = "0x00000000000000000000000000000000000000cc" as Address;
const APP = ("0x" + "ab".repeat(32)) as Hex;
const TERMS = ("0x" + "11".repeat(32)) as Hex;

function client(opts: { fee: bigint; allowance: bigint; status?: PublisherStatus }) {
	const writes: string[] = [];
	const publicClient = {
		readContract: ({ functionName }: { functionName: string }) =>
			Promise.resolve(
				{
					subscriptionFee: opts.fee,
					usdc: USDC,
					allowance: opts.allowance,
					joinInfo: [TERMS, "", 0n, opts.status ?? PublisherStatus.UNREGISTERED, false],
				}[functionName],
			),
		estimateFeesPerGas: () => Promise.resolve({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
		estimateContractGas: () => Promise.resolve(1n),
		waitForTransactionReceipt: () => Promise.resolve({}),
	} as unknown as PublicClient;
	const walletClient = {
		chain: {},
		account: { address: SELF },
		writeContract: ({ address, functionName }: { address: Address; functionName: string }) => {
			writes.push(`${functionName}@${address === USDC ? "usdc" : "registry"}`);
			return Promise.resolve("0xhash");
		},
	} as unknown as WalletClient;
	return { apps: new AppRegistryClient(REGISTRY, APP, publicClient, walletClient), writes };
}

describe("AppRegistryClient subscription + invitation", () => {
	it("approves the subscription fee before claiming when the allowance is short", async () => {
		const { apps, writes } = client({ fee: 5n, allowance: 4n });
		await apps.registerApp(TERMS, "");
		expect(writes).toEqual(["approve@usdc", "registerApp@registry"]);
	});

	it("skips the approve when the allowance covers it, or the fee is zero", async () => {
		const covered = client({ fee: 5n, allowance: 5n });
		await covered.apps.renewApp();
		expect(covered.writes).toEqual(["renewApp@registry"]);

		const free = client({ fee: 0n, allowance: 0n });
		await free.apps.registerApp(TERMS, "");
		expect(free.writes).toEqual(["registerApp@registry"]);
	});

	it("refuses to join an app the owner never added this wallet to", async () => {
		const uninvited = client({ fee: 0n, allowance: 0n });
		await expect(uninvited.apps.registerForApp()).rejects.toThrow(/has not been added/);
		expect(uninvited.writes).toEqual([]);

		const invited = client({ fee: 0n, allowance: 0n, status: PublisherStatus.INVITED });
		await invited.apps.registerForApp();
		expect(invited.writes).toEqual(["registerForApp@registry"]);
	});
});
