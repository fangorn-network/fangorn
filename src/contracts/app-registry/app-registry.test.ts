import { describe, it, expect } from "vitest";
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { AppRegistryClient } from "./index.js";

const REGISTRY = "0x00000000000000000000000000000000000000aa" as Address;
const SELF = "0x00000000000000000000000000000000000000cc" as Address;
const APP = ("0x" + "ab".repeat(32)) as Hex;
// What APP was renamed to: the contract resolves it back to APP.
const ALIAS = ("0x" + "cd".repeat(32)) as Hex;
const NOW = 1_000n;

function client(opts: { appId?: Hex }) {
	const writes: { call: string; args: readonly unknown[] }[] = [];
	const reads: { functionName: string; args: readonly unknown[] }[] = [];
	const publicClient = {
		readContract: ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
			reads.push({ functionName, args });
			return Promise.resolve(
				{
					canonicalAppId: args[0] === ALIAS ? APP : args[0],
					curatorOf: [SELF, "picks"],
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
			writes.push({ call: q.functionName, args: q.args });
			return Promise.resolve("0xhash");
		},
	} as unknown as WalletClient;
	const apps = new AppRegistryClient(REGISTRY, opts.appId ?? APP, publicClient, walletClient);
	return { apps, calls: () => writes.map((w) => w.call), writes, reads };
}

describe("AppRegistryClient apps", () => {
	it("registers this client's app, for free", async () => {
		const { apps, calls, writes } = client({});
		await apps.registerApp();
		expect(calls()).toEqual(["registerApp"]);
		expect(writes[0].args).toEqual([APP]);
	});

	it("sets and reads the app's repo and payout", async () => {
		const { apps, calls, writes } = client({});
		await apps.setCurator(SELF, "picks");
		await apps.setPayout(SELF);
		expect(calls()).toEqual(["setCurator", "setPayout"]);
		expect(writes.map((w) => w.args)).toEqual([[APP, SELF, "picks"], [APP, SELF]]);
		expect(await apps.curatorOf()).toEqual({ curator: SELF, repo: "picks" });
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

// A renamed app answers to every id it went by, but its events carry the id it was
// registered under: the client resolves that before filtering on it.
describe("AppRegistryClient renaming", () => {
	it("renames this client's app to the new id", async () => {
		const { apps, calls, writes } = client({});
		await apps.renameApp(ALIAS);
		expect(calls()).toEqual(["renameApp"]);
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
