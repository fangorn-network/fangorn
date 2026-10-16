import { describe, it, expect } from "vitest";
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { AppRegistryClient } from "./index.js";
import { PublisherStatus } from "../types.js";

// Every fee is pulled in USDC with transferFrom, and joining needs the owner's
// invitation and a live app. Both are checked client-side so the caller gets a
// reason instead of a bare revert.

const REGISTRY = "0x00000000000000000000000000000000000000aa" as Address;
const USDC = "0x00000000000000000000000000000000000000bb" as Address;
const SELF = "0x00000000000000000000000000000000000000cc" as Address;
const APP = ("0x" + "ab".repeat(32)) as Hex;
const TERMS = ("0x" + "11".repeat(32)) as Hex;
const NOW = 1_000n;
const PERIOD = 30n;

function client(opts: {
	fee?: bigint;
	joinFee?: bigint;
	allowance?: bigint;
	status?: PublisherStatus;
	expiresAt?: bigint;
	renewable?: boolean;
}) {
	const writes: { call: string; args: readonly unknown[] }[] = [];
	const simulated: string[] = [];
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
					access: [false, SELF, opts.expiresAt ?? NOW + PERIOD],
					joinInfo: [TERMS, "", opts.joinFee ?? 0n, opts.status ?? PublisherStatus.NONE, false],
				}[functionName],
			),
		getBlock: () => Promise.resolve({ timestamp: NOW }),
		estimateFeesPerGas: () => Promise.resolve({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
		estimateContractGas: ({ functionName }: { functionName: string }) => {
			simulated.push(functionName);
			return Promise.resolve(1n);
		},
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
	return { apps, calls: () => writes.map((w) => w.call), writes, simulated };
}

describe("AppRegistryClient subscription", () => {
	it("approves exactly the subscription fee and caps the claim at it", async () => {
		const { apps, calls, writes } = client({ fee: 5n, allowance: 4n });
		await apps.registerApp(TERMS, "", 2n);
		expect(calls()).toEqual(["approve@usdc", "registerApp@registry"]);
		expect(writes[0].args).toEqual([REGISTRY, 5n]);
		expect(writes[1].args).toEqual([APP, TERMS, "", 2n, 5n]);
	});

	it("skips the approve when the allowance covers it, or the fee is zero", async () => {
		const covered = client({ fee: 5n, allowance: 5n });
		await covered.apps.renewSubscription();
		expect(covered.calls()).toEqual(["renewSubscription@registry"]);
		expect(covered.writes[0].args).toEqual([BigInt(APP), PERIOD]);

		const free = client({});
		await free.apps.registerApp(TERMS, "");
		expect(free.calls()).toEqual(["registerApp@registry"]);
	});

	it("refuses to renew with a period or more left", async () => {
		const { apps, calls } = client({ renewable: false });
		await expect(apps.renewSubscription()).rejects.toThrow(/cannot be renewed/);
		expect(calls()).toEqual([]);
	});
});

describe("AppRegistryClient.joinApp", () => {
	it("refuses an app the owner never invited this wallet to", async () => {
		const { apps, calls } = client({});
		await expect(apps.joinApp()).rejects.toThrow(/has not been invited/);
		expect(calls()).toEqual([]);
	});

	it("refuses a member, who accepts new terms instead", async () => {
		const { apps } = client({ status: PublisherStatus.ACTIVE });
		await expect(apps.joinApp()).rejects.toThrow(/acceptUpdatedTerms/);
	});

	it("refuses an app whose subscription has expired, by block time", async () => {
		const { apps, calls } = client({ status: PublisherStatus.INVITED, expiresAt: NOW });
		await expect(apps.joinApp()).rejects.toThrow(/expired/);
		expect(calls()).toEqual([]);
	});

	it("approves exactly the join fee and caps the join at it", async () => {
		const { apps, calls, writes } = client({ status: PublisherStatus.INVITED, joinFee: 7n });
		await apps.joinApp();
		expect(calls()).toEqual(["approve@usdc", "joinApp@registry"]);
		expect(writes[0].args).toEqual([REGISTRY, 7n]);
		expect(writes[1].args).toEqual([APP, TERMS, 7n]);
	});
});

// A browser wallet signs both: the approval first, and the join only simulates
// once nothing has to land before it.
describe("AppRegistryClient.prepareJoinApp", () => {
	it("returns the approval then an unsimulated join when the allowance is short", async () => {
		const { apps, simulated } = client({ status: PublisherStatus.INVITED, joinFee: 7n, allowance: 6n });
		const txs = await apps.prepareJoinApp(SELF);
		expect(txs.map((tx) => tx.to)).toEqual([USDC, REGISTRY]);
		expect(simulated).toEqual(["approve"]);
	});

	it("returns the simulated join alone when the allowance covers it", async () => {
		const { apps, simulated } = client({ status: PublisherStatus.INVITED, joinFee: 7n, allowance: 7n });
		const txs = await apps.prepareJoinApp(SELF);
		expect(txs.map((tx) => tx.to)).toEqual([REGISTRY]);
		expect(simulated).toEqual(["joinApp"]);
	});
});

// The contract cannot list a publisher's apps. The invitations are found in the
// logs, and whether each still stands is read from the contract.
describe("AppRegistryClient.getInvitations", () => {
	const OWNER = "0x00000000000000000000000000000000000000dd" as Address;
	const PENDING = ("0x" + "01".repeat(32)) as Hex;
	const JOINED = ("0x" + "02".repeat(32)) as Hex;
	const WITHDRAWN = ("0x" + "03".repeat(32)) as Hex;
	const FROM = 100n;
	const HEAD = FROM + 2_500_000n;

	function invited(statuses: Record<Hex, PublisherStatus>) {
		const scans: { publisher: Address; fromBlock: bigint; toBlock: bigint }[] = [];
		const publicClient = {
			getBlockNumber: () => Promise.resolve(HEAD),
			getContractEvents: (q: { args: { publisher: Address }; fromBlock: bigint; toBlock: bigint }) => {
				scans.push({ publisher: q.args.publisher, fromBlock: q.fromBlock, toBlock: q.toBlock });
				return Promise.resolve(
					Object.keys(statuses).map((appId, i) => ({
						args: { app_id: appId, publisher: SELF },
						blockNumber: FROM + BigInt(i),
					})),
				);
			},
			readContract: ({ functionName, args }: { functionName: string; args: [Hex, ...unknown[]] }) =>
				Promise.resolve(
					{
						joinInfo: [TERMS, "ipfs://terms", 7n, statuses[args[0]], false],
						getAppOwner: OWNER,
						appAgentUri: "https://card.test/",
					}[functionName],
				),
		} as unknown as PublicClient;
		const apps = new AppRegistryClient(REGISTRY, APP, publicClient, {} as WalletClient);
		return { apps, scans };
	}

	it("lists only the apps still waiting for the publisher to join", async () => {
		const { apps } = invited({
			[PENDING]: PublisherStatus.INVITED,
			[JOINED]: PublisherStatus.ACTIVE,
			[WITHDRAWN]: PublisherStatus.SUSPENDED,
		});
		expect(await apps.getInvitations(SELF, { fromBlock: FROM })).toEqual([
			{
				appId: PENDING,
				owner: OWNER,
				termsHash: TERMS,
				termsUri: "ipfs://terms",
				joinFee: 7n,
				agentUri: "https://card.test/",
				blockNumber: FROM,
			},
		]);
	});

	it("asks for the publisher's logs from the deploy block, in one wide window", async () => {
		const { apps, scans } = invited({});
		expect(await apps.getInvitations(SELF, { fromBlock: FROM })).toEqual([]);
		// 2.5M blocks: 2,500 calls at the default window, one at this query's.
		expect(scans).toEqual([{ publisher: SELF, fromBlock: FROM, toBlock: HEAD }]);
	});
});
