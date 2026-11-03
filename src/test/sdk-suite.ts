import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	bytesToHex,
	hexToBytes,
	keccak256,
	stringToBytes,
	type Hex,
} from "viem";
import { generatePrivateKey } from "viem/accounts";
import { ZERO_HEAD } from "../contracts/index.js";
import {
	sealSelf,
	unsealSelf,
	GADGET_SELF_HKDF_V1,
} from "../crypto/encryption.js";
import type { Fangorn, RepoChange } from "../fangorn.js";
import type { Network } from "./testbed.js";

// The SDK's behaviour, end to end, on any network: memory (src/sdk.test.ts) or
// the contracts on anvil (src/e2e/sdk.e2e.test.ts). Each test takes fresh
// wallets and repo names, so they share one network.

export const head = (f: Fangorn, repo: string) =>
	f.getRegistry().head({ publisher: f.getAddress(), repo });

/** Take the first n entries of the stream and then stop. */
export async function take(
	stream: AsyncGenerator<RepoChange>,
	n: number,
): Promise<RepoChange[]> {
	const out: RepoChange[] = [];
	for await (const c of stream) {
		out.push(c);
		if (out.length === n) break;
	}
	return out;
}

export function sdkSuite(makeNetwork: () => Promise<Network>, timeout = 5_000) {
	let net: Network;
	beforeAll(async () => {
		net = await makeNetwork();
	}, 120_000);
	afterAll(() => {
		net.stop();
	});

	describe("publishing", () => {
		it(
			"a publisher uploads records and reads them back",
			async () => {
				const f = await net.client();
				await f.initRepo("r");
				const a = await f.upload("r", { event: "one" }, "event", "a");
				const b = await f.upload("r", { event: "two" }, "event", "b");

				expect(
					(await f.engine.readRecord(f.getAddress(), "r", "a"))?.payload,
				).toEqual({ event: "one" });
				const { records } = await f.inspectRepo("r");
				expect(records.map((r) => r.cid).sort()).toEqual(
					[a.payloadCid, b.payloadCid].sort(),
				);
			},
			timeout,
		);

		it(
			"can't upload to a repo that was never initialized",
			async () => {
				const f = await net.client();
				await expect(f.upload("nope", { x: 1 }, "t")).rejects.toThrow(
					/initRepo/,
				);
			},
			timeout,
		);

		it(
			"keeps each repo's head and records to itself",
			async () => {
				const f = await net.client();
				await f.initRepo("a");
				const headA = await head(f, "a");
				await f.initRepo("b");
				const headB = await head(f, "b");
				expect(headA).not.toBe(ZERO_HEAD);
				expect(headB).not.toBe(headA);
				expect(await head(f, "untouched")).toBe(ZERO_HEAD);

				await f.upload("a", { n: 1 }, "t", "x");
				expect(await head(f, "a")).not.toBe(headA);
				expect(await head(f, "b")).toBe(headB);
				expect((await f.inspectRepo("b")).records).toEqual([]);
			},
			timeout,
		);

		it(
			"publishes a batch as one entry of the ordering",
			async () => {
				const f = await net.client();
				await f.initRepo("batch");
				const records = Array.from({ length: 25 }, (_, i) => ({
					id: `v-${String(i)}`,
					type: "t",
					payload: { i },
				}));

				const before = await net.clock();
				const res = await f.uploadBatch("batch", records);
				expect((await net.clock()) - before).toBe(1n);
				expect(Object.keys(res.recordCids)).toHaveLength(25);
				expect((await f.inspectRepo("batch")).records).toHaveLength(25);
			},
			timeout,
		);

		it(
			"stores a payload sealed to its publisher as opaque bytes",
			async () => {
				const sk = generatePrivateKey();
				const f = await net.client(sk);
				await f.initRepo("private");
				const resourceId = keccak256(stringToBytes("private:secret"));
				const ciphertext = sealSelf(
					new TextEncoder().encode("the eagles are coming"),
					hexToBytes(sk),
					resourceId,
				);

				const { id } = await f.upload(
					"private",
					{
						gadget: GADGET_SELF_HKDF_V1,
						resourceId,
						ciphertext: bytesToHex(ciphertext),
					},
					"sealed",
				);
				const stored = (
					await f.engine.readRecord(f.getAddress(), "private", id)
				)?.payload as { ciphertext: Hex };
				expect(
					new TextDecoder().decode(
						unsealSelf(
							hexToBytes(stored.ciphertext),
							hexToBytes(sk),
							resourceId,
						),
					),
				).toBe("the eagles are coming");
				expect(() =>
					unsealSelf(
						hexToBytes(stored.ciphertext),
						new Uint8Array(32).fill(0xab),
						resourceId,
					),
				).toThrow();
			},
			timeout,
		);

		it(
			"reset empties a repo with a new commit, without zeroing its head",
			async () => {
				const f = await net.client();
				await f.initRepo("r");
				await f.upload("r", { n: 1 }, "t", "x");
				const before = await head(f, "r");
				await f.reset("r");
				expect(await head(f, "r")).not.toBe(before);
				expect(await head(f, "r")).not.toBe(ZERO_HEAD);
				expect((await f.inspectRepo("r")).records).toEqual([]);
			},
			timeout,
		);

		it(
			"refuses to push a commit whose parent is no longer the head",
			async () => {
				const f = await net.client();
				await f.initRepo("r");
				// built on the empty history, while the head has moved on
				const stale = await f.commit({
					repo: "r",
					records: [{ id: "x", type: "t", payload: {} }],
				});
				await expect(f.push("r", stale.commitCid)).rejects.toThrow(
					/stale parent/,
				);
			},
			timeout,
		);
	});

	describe("reading other publishers", () => {
		it(
			"any client reads any publisher's repo, and lists every repo",
			async () => {
				const reader = await net.client();
				const pub = await net.client();
				await pub.initRepo("catalog");
				const { payloadCid } = await pub.upload(
					"catalog",
					{ title: "t" },
					"entry",
					"g",
				);

				const { contents } = await reader.readRepo(pub.getAddress(), "catalog");
				expect(contents.records.map((r) => r.cid)).toEqual([payloadCid]);
				const listed = await reader.repos({ owner: pub.getAddress() });
				expect(listed.map((d) => [d.owner, d.repo])).toEqual([
					[pub.getAddress(), "catalog"],
				]);
			},
			timeout,
		);
	});

	describe("subscriptions", () => {
		it(
			"replays from a block, then follows live",
			async () => {
				const pub = await net.client();
				const from = await net.clock();
				await pub.initRepo("feed");
				await pub.upload("feed", { n: 1 }, "t", "a");

				const ctl = new AbortController();
				const reader = await net.client();
				const stream = reader.subscribeAll({
					owner: pub.getAddress(),
					fromBlock: from,
					signal: ctl.signal,
					pollingInterval: 100,
				});
				const first = await stream.next();
				expect((first.value as RepoChange).puts.map((r) => r.id)).toEqual([
					"a",
				]);

				const second = stream.next();
				await pub.upload("feed", { n: 2 }, "t", "b");
				const live = (await second).value as RepoChange;
				expect([live.repo, live.owner, live.puts.map((r) => r.id)]).toEqual([
					"feed",
					pub.getAddress(),
					["b"],
				]);
				ctl.abort();
				await stream.return(undefined);
			},
			timeout,
		);
	});
}
