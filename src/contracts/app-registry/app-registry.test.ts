import { describe, it, expect } from "vitest";
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { AppRegistryClient } from "./index.js";

// Every fee is pulled in USDC with transferFrom: the client approves exactly the
// fee, and refuses a renewal the contract would refuse, with a reason.

const REGISTRY = "0x00000000000000000000000000000000000000aa" as Address;
const USDC = "0x00000000000000000000000000000000000000bb" as Address;
const SELF = "0x00000000000000000000000000000000000000cc" as Address;
const APP = ("0x" + "ab".repeat(32)) as Hex;
const NOW = 1_000n;
const PERIOD = 30n;

function client(opts: { fee?: bigint; allowance?: bigint; expiresAt?: bigint; renewable?: boolean }) {
	const writes: { call: string; args: readonly unknown[] }[] = [];
	const publicClient = {
		readContract: ({ functionName }: { functionName: string }) =>
			Promise.resolve(
				{
					subscriptionFee: opts.fee ?? 0n,
					subscriptionPeriod: PERIOD,
					isRenewable: opts.renewable ?? true,
					expiresAt: opts.expiresAt ?? NOW + PERIOD,
					usdc: USDC,
					allowance: opts.allowance ?? 0n,
				}[functionName],
			),
		getBlock: () => Promise.resolve({ timestamp: NOW }),
		estimateFeesPerGas: () => Promise.resolve({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
		estimateContractGas: () => Promise.resolve(1n),
		waitForTransactionReceipt: () => Promise.resolve({}),
	} as unknown as PublicClient;
	const walletClient = {
		chain: {},
		account: { address: SELF },
		writeContract: (q: { address: Address; functionName: string; args: readonly unknown[] }) => {
			writes.push({ call: `${q.functionName}@${q.address === USDC ? "usdc" : "registry"}`, args: q.args });
			return Promise.resolve("0xhash");
		},
	} as unknown as WalletClient;
	const apps = new AppRegistryClient(REGISTRY, APP, publicClient, walletClient);
	return { apps, calls: () => writes.map((w) => w.call), writes };
}

describe("AppRegistryClient subscription", () => {
	it("approves exactly the subscription fee and caps the claim at it", async () => {
		const { apps, calls, writes } = client({ fee: 5n, allowance: 4n });
		await apps.registerApp();
		expect(calls()).toEqual(["approve@usdc", "registerApp@registry"]);
		expect(writes[0].args).toEqual([REGISTRY, 5n]);
		expect(writes[1].args).toEqual([APP, 5n]);
	});

	it("skips the approve when the allowance covers it, or the fee is zero", async () => {
		const covered = client({ fee: 5n, allowance: 5n });
		await covered.apps.renewSubscription();
		expect(covered.calls()).toEqual(["renewSubscription@registry"]);
		expect(covered.writes[0].args).toEqual([BigInt(APP), PERIOD]);

		const free = client({});
		await free.apps.registerApp();
		expect(free.calls()).toEqual(["registerApp@registry"]);
	});

	it("refuses to renew with a period or more left", async () => {
		const { apps, calls } = client({ renewable: false });
		await expect(apps.renewSubscription()).rejects.toThrow(/cannot be renewed/);
		expect(calls()).toEqual([]);
	});
});

describe("AppRegistryClient publishers", () => {
	it("the owner accepts a publisher in one call, and no fee moves", async () => {
		const { apps, calls, writes } = client({ fee: 5n });
		await apps.acceptPublisher(SELF);
		expect(calls()).toEqual(["acceptPublisher@registry"]);
		expect(writes[0].args).toEqual([APP, SELF]);
	});
});

describe("AppRegistryClient listing", () => {
	it("lists every app with one count and one page, from the start", async () => {
		const reads: { functionName: string; args: readonly unknown[] }[] = [];
		const publicClient = {
			readContract: (q: { functionName: string; args: readonly unknown[] }) => {
				reads.push(q);
				return Promise.resolve(q.functionName === "appCount" ? 2n : [APP, APP]);
			},
		} as unknown as PublicClient;
		const apps = new AppRegistryClient(REGISTRY, undefined, publicClient, {} as WalletClient);
		expect(await apps.allApps()).toEqual([APP, APP]);
		expect(reads.map((r) => [r.functionName, r.args])).toEqual([
			["appCount", []],
			["appsPage", [0n, 2n]],
		]);
	});
});
