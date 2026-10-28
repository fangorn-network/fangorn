import { describe, it, expect } from "vitest";
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { AppRegistryClient } from "./index.js";

// Every fee is pulled in USDC with transferFrom: the client approves exactly the
// fee, and refuses a renewal the contract would refuse, with a reason.

const REGISTRY = "0x00000000000000000000000000000000000000aa" as Address;
const USDC = "0x00000000000000000000000000000000000000bb" as Address;
const SELF = "0x00000000000000000000000000000000000000cc" as Address;
const APP = ("0x" + "ab".repeat(32)) as Hex;
// What APP was renamed to: the contract resolves it back to APP.
const ALIAS = ("0x" + "cd".repeat(32)) as Hex;
const NOW = 1_000n;
const PERIOD = 30n;

function client(opts: { fee?: bigint; allowance?: bigint; expiresAt?: bigint; renewable?: boolean; appId?: Hex }) {
	const writes: { call: string; args: readonly unknown[] }[] = [];
	const reads: { functionName: string; args: readonly unknown[] }[] = [];
	const publicClient = {
		readContract: ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
			reads.push({ functionName, args });
			return Promise.resolve(
				{
					subscriptionFee: opts.fee ?? 0n,
					subscriptionPeriod: PERIOD,
					isRenewable: opts.renewable ?? true,
					expiresAt: opts.expiresAt ?? NOW + PERIOD,
					usdc: USDC,
					allowance: opts.allowance ?? 0n,
					canonicalAppId: args[0] === ALIAS ? APP : args[0],
				}[functionName],
			);
		},
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
	const apps = new AppRegistryClient(REGISTRY, opts.appId ?? APP, publicClient, walletClient);
	return { apps, calls: () => writes.map((w) => w.call), writes, reads };
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

// A renamed app answers to every id it went by, but its token and its events carry
// the id it was claimed under: the client resolves that before using either.
describe("AppRegistryClient renaming", () => {
	it("renames this client's app to the new id", async () => {
		const { apps, calls, writes } = client({});
		await apps.renameApp(ALIAS);
		expect(calls()).toEqual(["renameApp@registry"]);
		expect(writes[0].args).toEqual([APP, ALIAS]);
		// The client keeps the id it had, which still resolves.
		expect(apps.getAppId()).toBe(APP);
	});

	it("refuses to rename with no app chosen", async () => {
		const apps = new AppRegistryClient(REGISTRY, undefined, {} as PublicClient, {} as WalletClient);
		await expect(apps.renameApp(ALIAS)).rejects.toThrow(/no app chosen/);
	});

	it("reads the canonical and current ids of this app, or of another", async () => {
		const { apps, reads } = client({ appId: ALIAS });
		expect(await apps.canonicalAppId()).toBe(APP);
		await apps.currentAppId(APP);
		expect(reads.map((r) => [r.functionName, r.args])).toEqual([
			["canonicalAppId", [ALIAS]],
			["currentAppId", [APP]],
		]);
	});

	it("uses the canonical id as the token id under an alias", async () => {
		const { apps, writes, reads } = client({ appId: ALIAS });
		expect(await apps.tokenId()).toBe(BigInt(APP));
		await apps.renewSubscription();
		await apps.cancelSubscription();
		expect(writes.map((w) => w.args[0])).toEqual([BigInt(APP), BigInt(APP)]);
		await apps.expiresAt();
		expect(reads.filter((r) => r.functionName === "expiresAt" || r.functionName === "isRenewable").map((r) => r.args)).toEqual([
			[BigInt(APP)],
			[BigInt(APP)],
		]);
	});

	it("filters agent logs by the canonical id, and scans every app without one", async () => {
		const filters: unknown[] = [];
		const publicClient = {
			readContract: ({ args }: { args: readonly unknown[] }) => Promise.resolve(args[0] === ALIAS ? APP : args[0]),
			getContractEvents: (q: { args: unknown }) => {
				filters.push(q.args);
				return Promise.resolve([]);
			},
		} as unknown as PublicClient;
		const apps = new AppRegistryClient(REGISTRY, ALIAS, publicClient, {} as WalletClient);
		await apps.getAppAgentLogs({ appId: ALIAS, fromBlock: 0n, toBlock: 0n });
		await apps.getAppAgentLogs({ fromBlock: 0n, toBlock: 0n });
		expect(filters).toEqual([{ app_id: APP }, {}]);
	});
});
