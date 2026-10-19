import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes, keccak256, stringToBytes, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { ZERO_HEAD } from "../registry.js";
import { sealSelf, unsealSelf, GADGET_SELF_HKDF_V1 } from "../crypto/encryption.js";
import type { Fangorn, RepoChange } from "../fangorn.js";
import { TEST_APP, type Network } from "./testbed.js";

// The SDK's behaviour, end to end, on any network: memory (src/sdk.test.ts) or
// the contracts on anvil (src/e2e/sdk.e2e.test.ts). Each test takes fresh
// wallets and repo names, so they share one network.

/** The app a test client was made under. */
export function appOf(f: Fangorn): Hex {
	const app = f.getAppId();
	if (!app) throw new Error("this client has no app");
	return app;
}

export const head = (f: Fangorn, repo: string) => f.getRegistry().head({ publisher: f.getAddress(), repo });

/** Take the first n entries of the stream and then stop. */
export async function take(stream: AsyncGenerator<RepoChange>, n: number): Promise<RepoChange[]> {
	const out: RepoChange[] = [];
	for await (const c of stream) {
		out.push(c);
		if (out.length === n) break;
	}
	return out;
}

/** A fresh app name, so a test's owner and exclusions are its own. */
const freshApp = () => `app-${Math.random().toString(36).slice(2)}`;

export function sdkSuite(makeNetwork: () => Promise<Network>, timeout = 5_000) {
	let net: Network;
	beforeAll(async () => {
		net = await makeNetwork();
	}, 120_000);
	afterAll(() => {
		net.stop();
	});

	describe("publishing", () => {
		it("a publisher uploads records and reads them back", async () => {
			const f = await net.client();
			await f.initRepo("r");
			const a = await f.upload("r", { event: "one" }, "event", "a");
			const b = await f.upload("r", { event: "two" }, "event", "b");

			expect((await f.engine.readRecord(f.getAddress(), "r", "a"))?.payload).toEqual({ event: "one" });
			const { records } = await f.inspectRepo("r");
			expect(records.map((r) => r.cid).sort()).toEqual([a.payloadCid, b.payloadCid].sort());
		}, timeout);

		it("can't upload to a repo that was never initialized", async () => {
			const f = await net.client();
			await expect(f.upload("nope", { x: 1 }, "t")).rejects.toThrow(/initRepo/);
		}, timeout);

		it("keeps each repo's head and records to itself", async () => {
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
		}, timeout);

		it("publishes a batch as one entry of the ordering", async () => {
			const f = await net.client();
			await f.initRepo("batch");
			const records = Array.from({ length: 25 }, (_, i) => ({ id: `v-${String(i)}`, type: "t", payload: { i } }));

			const before = await net.clock();
			const res = await f.uploadBatch("batch", records);
			expect((await net.clock()) - before).toBe(1n);
			expect(Object.keys(res.recordCids)).toHaveLength(25);
			expect((await f.inspectRepo("batch")).records).toHaveLength(25);
		}, timeout);

		it("stores a payload sealed to its publisher as opaque bytes", async () => {
			const sk = generatePrivateKey();
			const f = await net.client(TEST_APP, sk);
			await f.initRepo("private");
			const resourceId = keccak256(stringToBytes("private:secret"));
			const ciphertext = sealSelf(new TextEncoder().encode("the eagles are coming"), hexToBytes(sk), resourceId);

			const { id } = await f.upload(
				"private",
				{ gadget: GADGET_SELF_HKDF_V1, resourceId, ciphertext: bytesToHex(ciphertext) },
				"sealed",
			);
			const stored = (await f.engine.readRecord(f.getAddress(), "private", id))?.payload as { ciphertext: Hex };
			expect(new TextDecoder().decode(unsealSelf(hexToBytes(stored.ciphertext), hexToBytes(sk), resourceId))).toBe(
				"the eagles are coming",
			);
			expect(() => unsealSelf(hexToBytes(stored.ciphertext), new Uint8Array(32).fill(0xab), resourceId)).toThrow();
		}, timeout);

		it("reset empties a repo with a new commit, without zeroing its head", async () => {
			const f = await net.client();
			await f.initRepo("r");
			await f.upload("r", { n: 1 }, "t", "x");
			const before = await head(f, "r");
			await f.reset("r");
			expect(await head(f, "r")).not.toBe(before);
			expect(await head(f, "r")).not.toBe(ZERO_HEAD);
			expect((await f.inspectRepo("r")).records).toEqual([]);
		}, timeout);

		it("refuses to push a commit whose parent is no longer the head", async () => {
			const f = await net.client();
			await f.initRepo("r");
			// built on the empty history, while the head has moved on
			const stale = await f.commit({ repo: "r", records: [{ id: "x", type: "t", payload: {} }], message: "m" });
			await expect(f.push("r", stale.commitCid)).rejects.toThrow(/stale parent/);
		}, timeout);
	});

	describe("apps present what they accept", () => {
		it("one member reads another's repo, and the app lists both", async () => {
			const app = freshApp();
			const owner = await net.client(app);
			const guest = await net.client(app);
			await owner.initRepo("catalog");
			await guest.initRepo("catalog");
			const { payloadCid } = await guest.upload("catalog", { title: "from the guest" }, "entry", "g");

			const { contents } = await owner.readRepo(guest.getAddress(), "catalog");
			expect(contents.records.map((r) => r.cid)).toEqual([payloadCid]);
			const listed = await owner.appRepos({ repo: "catalog" });
			expect(listed.map((d) => d.owner).sort()).toEqual([owner.getAddress(), guest.getAddress()].sort());
			expect(listed.every((d) => d.repo === "catalog")).toBe(true);
		}, timeout);

		it("an update by itself changes what no app presents, until the app accepts it", async () => {
			const app = freshApp();
			const owner = await net.client(app);
			// Publishes under no app: its own word, presented nowhere.
			const loner = await net.client(null);
			await loner.initRepo("notes");
			await loner.upload("notes", { n: 1 }, "t", "x");

			const ref = { publisher: loner.getAddress(), repo: "notes" };
			expect((await owner.readRepo(ref.publisher, "notes")).contents.records).toEqual([]);
			expect(await owner.appRepos()).toEqual([]);
			const outsider = await net.client(null);
			expect((await outsider.readRepo(ref.publisher, "notes")).contents.records).toHaveLength(1);

			// The app pulls it: the owner accepts the current head.
			await owner.getRegistry().accept(appOf(owner), ref);
			expect((await owner.readRepo(ref.publisher, "notes")).contents.records).toHaveLength(1);

			// A newer head is the publisher's until the app accepts that too.
			await loner.upload("notes", { n: 2 }, "t", "y");
			expect((await owner.readRepo(ref.publisher, "notes")).contents.records).toHaveLength(1);
			expect((await outsider.readRepo(ref.publisher, "notes")).contents.records).toHaveLength(2);
		}, timeout);

		it("an excluded publisher disappears from the app's reads, and a restore brings it back", async () => {
			const app = freshApp();
			const owner = await net.client(app);
			const guest = await net.client(app);
			await guest.initRepo("catalog");
			await guest.upload("catalog", { title: "t" }, "entry", "g");
			const x = { publisher: guest.getAddress() };
			const appId = appOf(owner);

			await owner.getRegistry().exclude(appId, x);
			expect(await owner.appRepos()).toEqual([]);
			expect((await owner.readRepo(guest.getAddress(), "catalog")).contents.records).toEqual([]);

			await owner.getRegistry().restore(appId, x);
			expect(await owner.appRepos()).toHaveLength(1);
			expect((await owner.readRepo(guest.getAddress(), "catalog")).contents.records).toHaveLength(1);
		}, timeout);

		it("a repo exclusion hides that repo only", async () => {
			const app = freshApp();
			const owner = await net.client(app);
			const guest = await net.client(app);
			for (const repo of ["keep", "drop"]) {
				await guest.initRepo(repo);
				await guest.upload(repo, { repo }, "t", "x");
			}
			await owner.getRegistry().exclude(appOf(owner), { publisher: guest.getAddress(), repo: "drop" });

			expect((await owner.appRepos()).map((d) => d.repo)).toEqual(["keep"]);
			expect((await owner.readRepo(guest.getAddress(), "drop")).contents.records).toEqual([]);
			expect((await owner.readRepo(guest.getAddress(), "keep")).contents.records).toHaveLength(1);
		}, timeout);

		it("an exclusion in one app hides nothing in another that accepted the same head", async () => {
			const [appA, appB] = [freshApp(), freshApp()];
			const ownerA = await net.client(appA);
			const ownerB = await net.client(appB);
			const guest = await net.client(appA);
			await guest.initRepo("catalog");
			await guest.upload("catalog", { title: "t" }, "entry", "g");
			const ref = { publisher: guest.getAddress(), repo: "catalog" };

			// One repo, presented by two apps: B pulls what A's member published.
			await ownerB.getRegistry().accept(appOf(ownerB), ref);
			await ownerA.getRegistry().exclude(appOf(ownerA), { publisher: ref.publisher });

			expect((await ownerA.readRepo(ref.publisher, "catalog")).contents.records).toEqual([]);
			expect((await ownerB.readRepo(ref.publisher, "catalog")).contents.records).toHaveLength(1);
		}, timeout);
	});

	describe("subscriptions", () => {
		it("replays from a block, then follows live", async () => {
			const app = freshApp();
			const pub = await net.client(app);
			const from = await net.clock();
			await pub.initRepo("feed");
			await pub.upload("feed", { n: 1 }, "t", "a");

			const ctl = new AbortController();
			const reader = await net.client(app);
			const stream = reader.subscribeApp({ fromBlock: from, signal: ctl.signal, pollingInterval: 100 });
			const first = await stream.next();
			expect((first.value as RepoChange).puts.map((r) => r.id)).toEqual(["a"]);

			const second = stream.next();
			await pub.upload("feed", { n: 2 }, "t", "b");
			const live = (await second).value as RepoChange;
			expect([live.repo, live.owner, live.puts.map((r) => r.id)]).toEqual(["feed", pub.getAddress(), ["b"]]);
			ctl.abort();
			await stream.return(undefined);
		}, timeout);
	});
}
