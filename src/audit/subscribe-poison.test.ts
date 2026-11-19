import { describe, expect, it, vi } from "vitest";
import { bytesToHex, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import { ZERO_HEAD } from "../contracts/index.js";
import type { RepoChange } from "../fangorn.js";
import { CommitFeed } from "../feed.js";
import { memoryNetwork, MemRegistry } from "../test/testbed.js";

// Audit: one log entry whose blocks can't be fetched — garbage from any address,
// or an honest commit a gateway hasn't propagated yet — against a reader of
// every repo, or of one repo name across publishers.

const junk = (): Hex => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));

/** An update anyone can send straight to the registry: no commit block behind it. */
async function poison(net: ReturnType<typeof memoryNetwork>, repo: string) {
	const attacker = privateKeyToAccount(generatePrivateKey()).address;
	const car = CID.createV1(raw.code, await sha256.digest(new Uint8Array([1])));
	await new MemRegistry(attacker, net.ledger).update({
		repo,
		epoch: await new MemRegistry(attacker, net.ledger).epoch(),
		parent: ZERO_HEAD,
		diff: junk(),
		root: junk(),
		car: bytesToHex(car.bytes),
	});
}

/** Drain a stream until it ends, recording what it yielded and how it ended. */
async function drain(stream: AsyncGenerator<RepoChange>, until: number) {
	const got: string[][] = [];
	try {
		for await (const c of stream) {
			got.push(c.puts.map((r) => r.id));
			if (got.length === until) break;
		}
		return { got, error: null as string | null };
	} catch (e) {
		return { got, error: (e as Error).message };
	}
}

describe("audit: a subscriber of every repo vs one unreadable entry", () => {
	it.each(["temporary", "persistent"])(
		"recovers a repo after a %s failure reading its first observed head",
		async (failure) => {
			const net = memoryNetwork();
			const pub = await net.client();
			const reader = await net.client();
			await pub.initRepo("feed");
			const first = await pub.upload("feed", { n: 1 }, "t", "a");
			const fromBlock = await net.clock();
			const { commitCid } = await pub.engine.createCommit({
				repo: "feed",
				base: CID.parse(first.commitCid),
				checkpoint: true,
				records: [{ id: "b", type: "t", payload: { n: 2 } }],
			});
			await pub.push("feed", commitCid.toString());
			const bytes = await net.storage.getRawBlock(first.commitCid);
			net.storage.blocks.delete(first.commitCid);
			const onSkip = vi.fn(() => {
				if (failure === "temporary")
					net.storage.blocks.set(first.commitCid, bytes);
			});
			const stream = reader.subscribeAll({ fromBlock, onSkip });
			const firstChange = await stream.next();
			await stream.return(undefined);
			expect(onSkip).toHaveBeenCalledTimes(1);
			if (firstChange.done) throw new Error("stream ended before recovery");
			expect(firstChange.value.puts.map((r) => r.id).sort()).toEqual([
				"a",
				"b",
			]);
		},
	);

	it.each([
		["subscribeAll()", {}],
		["subscribeAll({ repo })", { repo: "feed" }],
	])("%s keeps following honest publishers past it", async (_, filter) => {
		const net = memoryNetwork();
		const pub = await net.client();
		const reader = await net.client();
		await pub.initRepo("feed");
		await pub.upload("feed", { n: 1 }, "t", "a");
		await poison(net, "feed");
		await pub.upload("feed", { n: 2 }, "t", "b");

		const ctl = new AbortController();
		const stream = reader.subscribeAll({
			...filter,
			fromBlock: 0n,
			signal: ctl.signal,
		});
		const out = await drain(stream, 2);
		ctl.abort();
		// expected: both honest changes, the junk entry skipped
		expect(out).toEqual({ got: [["a"], ["b"]], error: null });
	});
});

describe("audit: CommitFeed restart", () => {
	it("catches up after the watch fails before its first delivery", async () => {
		const net = memoryNetwork();
		const pub = await net.client();
		const reader = await net.client();
		await pub.initRepo("feed");
		const registry = reader.getRegistry();
		vi.spyOn(registry, "log").mockRejectedValueOnce(new Error("RPC offline"));
		const failed = vi.fn();
		const delivered: string[] = [];
		const off = reader
			.feed()
			.on((change) => delivered.push(...change.puts.map((r) => r.id)), failed);
		try {
			await vi.waitFor(() => { expect(failed).toHaveBeenCalledOnce(); });
			await pub.upload("feed", { n: 1 }, "t", "during-restart");
			await vi.waitFor(() => { expect(delivered).toEqual(["during-restart"]); }, {
				timeout: 4000,
			});
		} finally {
			off();
		}
	});

	it("does not drop entries published while it is restarting", async () => {
		const net = memoryNetwork();
		const pub = await net.client();
		const reader = await net.client();
		await pub.initRepo("feed");

		const feed = new CommitFeed(
			// The poison is now skipped and reported (onSkip -> onError) rather than ending the
			// stream; a forced restart is covered in fangorn.fuzz.test.ts.
			(signal, fromBlock, onSkip) =>
				reader.subscribeAll({ signal, fromBlock, onSkip }),
			50,
		);
		const seen: string[][] = [];
		const errors: string[] = [];
		let failed!: () => void;
		const failure = new Promise<void>((r) => (failed = r));
		const off = feed.on(
			(c) => seen.push(c.puts.map((r) => r.id)),
			(e) => {
				errors.push(e.message);
				failed();
			},
		);
		await new Promise((r) => setTimeout(r, 10));
		await poison(net, "x"); // kills the open stream
		await failure;
		await pub.upload("feed", { n: 1 }, "t", "during-restart");
		await new Promise((r) => setTimeout(r, 150));
		await pub.upload("feed", { n: 2 }, "t", "after-restart");
		await new Promise((r) => setTimeout(r, 20));
		off();

		expect(errors.length).toBe(1);
		// expected: the change published during the restart is delivered too
		expect(seen).toEqual([["during-restart"], ["after-restart"]]);
	});
});
