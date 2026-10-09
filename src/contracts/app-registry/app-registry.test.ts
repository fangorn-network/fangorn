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
				fee: 7n,
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
