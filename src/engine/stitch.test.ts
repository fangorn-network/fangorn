import { describe, it, expect, beforeEach } from "vitest";
import type { CID } from "multiformats/cid";
import type { Hex } from "viem";
import { FangornEngine, type RecordInput } from "./index.js";
import { MemLedger, MemRegistry } from "../test/mem-registry.js";
import { MemStorage, PUBLISHER, newRegistry, rootHex } from "./test-helpers.js";

//  stitches operate across repo heads
const rec = (id: string, v: string): RecordInput => ({
	id,
	type: "t",
	payload: { v },
});

describe("stitches", () => {
	let engine: FangornEngine;
	const push = async (base: CID | null, records: RecordInput[]) => {
		// create a commit and push to storage
		const { commitCid } = await engine.createCommit({
			repo: "src",
			base,
			records,
		});
		await engine.pushCommit(PUBLISHER, "src", commitCid);
		return commitCid;
	};

	beforeEach(() => {
		engine = new FangornEngine(new MemStorage(), newRegistry());
	});

	it("resolves to the record as it was at that position, after the repo moves on", async () => {
		// null = no root cid (is the first)
		// TODO: reorg params so null is optional (default to null)
		const c1 = await push(null, [rec("a", "1")]);
		const s = await engine.stitchTo(PUBLISHER, "src", "a");
		expect(s).toEqual({
			publisher: PUBLISHER,
			repo: "src",
			pos: 1,
			head: rootHex(c1),
			key: "a",
		});
		expect((await engine.checkStitch(s)).latest).toBe(true);

		await push(c1, [rec("a", "2")]);

		const checked = await engine.checkStitch(s);
		expect(checked.latest).toBe(false);
		expect(checked.record?.payload).toEqual({ v: "1" });
	});

	it("makes and checks a stitch at the current generation without reading the log", async () => {
		const registry = newRegistry();
		registry.log = () => Promise.reject(new Error("log read"));
		engine = new FangornEngine(new MemStorage(), registry);
		const c1 = await push(null, [rec("a", "1")]);
		const c2 = await push(c1, [rec("a", "2")]);
		const s = await engine.stitchTo(PUBLISHER, "src", "a");
		expect(s.pos).toBe(2);
		expect(s.head).toBe(rootHex(c2));
		const checked = await engine.checkStitch(s);
		expect(checked.latest).toBe(true);
		expect(checked.record?.payload).toEqual({ v: "2" });
	});

	it("rejects a stitch whose head the repo never had at that position", async () => {
		const c1 = await push(null, [rec("a", "1")]);
		const c2 = await push(c1, [rec("a", "2")]);
		const s = await engine.stitchTo(PUBLISHER, "src", "a");
		await expect(
			engine.checkStitch({ ...s, head: rootHex(c1) }),
		).rejects.toThrow(/false stitch/);
		await expect(engine.checkStitch({ ...s, pos: 3 })).rejects.toThrow(
			/no position 3/,
		);
		expect(s.head).toBe(rootHex(c2));
	});

	it("without a key, names the event: its diff", async () => {
		const c1 = await push(null, [rec("a", "1"), rec("b", "1")]);
		await push(c1, [rec("b", "2")]);
		const s = await engine.stitchTo(PUBLISHER, "src");
		const { diff } = await engine.checkStitch(s);
		expect([...(diff?.keys() ?? [])]).toEqual(["b"]);
	});

	it("a missing key at a true stitch is null, not an error", async () => {
		await push(null, [rec("a", "1")]);
		const s = await engine.stitchTo(PUBLISHER, "src", "nope");
		expect((await engine.checkStitch(s)).record).toBeNull();
	});
});

describe("a stitch across repos", () => {
	const OTHER: Hex = "0x00000000000000000000000000000000000000b2";
	let ledger: MemLedger;
	let storage: MemStorage;
	let mine: FangornEngine;
	let theirs: FangornEngine;
	const push = async (
		e: FangornEngine,
		p: Hex,
		repo: string,
		base: CID | null,
	) => {
		const { commitCid } = await e.createCommit({
			repo,
			base,
			records: [rec("a", repo + String(base))],
		});
		await e.pushCommit(p, repo, commitCid);
		return commitCid;
	};
	const reader = () =>
		new FangornEngine(storage, new MemRegistry(OTHER, ledger));

	beforeEach(() => {
		ledger = new MemLedger();
		storage = new MemStorage();
		mine = new FangornEngine(storage, new MemRegistry(PUBLISHER, ledger));
		theirs = new FangornEngine(storage, new MemRegistry(OTHER, ledger));
	});

	it("folds the log into each repo's latest head, and keeps old stitches readable", async () => {
		const a1 = await push(mine, PUBLISHER, "a", null);
		const b1 = await push(theirs, OTHER, "b", null);
		const s1 = await mine.restitch(null);
		expect((await mine.readStitch(s1)).n).toBe(2);
		expect((await reader().stitchedHead(s1, PUBLISHER, "a"))?.equals(a1)).toBe(
			true,
		);
		expect((await reader().stitchedHead(s1, OTHER, "b"))?.equals(b1)).toBe(
			true,
		);
		expect(await reader().stitchedHead(s1, PUBLISHER, "c")).toBeNull();

		const a2 = await push(mine, PUBLISHER, "a", a1);
		const s2 = await mine.restitch(s1);
		expect((await mine.readStitch(s2)).n).toBe(3);
		// a fresh reader with only the stitch's name resolves both, old and new
		expect((await reader().stitchedHead(s2, PUBLISHER, "a"))?.equals(a2)).toBe(
			true,
		);
		expect((await reader().stitchedHead(s2, OTHER, "b"))?.equals(b1)).toBe(
			true,
		);
		expect((await reader().stitchedHead(s1, PUBLISHER, "a"))?.equals(a1)).toBe(
			true,
		);
	});

	it("an update gives the same root as a stitch built from scratch, uploading only new nodes", async () => {
		let prev: CID | null = null;
		const heads: CID[] = [];
		for (let i = 0; i < 40; i++)
			heads.push(await push(mine, PUBLISHER, `r${String(i)}`, null));
		prev = await mine.restitch(prev);
		await push(mine, PUBLISHER, "r7", heads[7]);
		const writes = storage.writes;
		const next = await mine.restitch(prev);
		expect(storage.writes - writes).toBe(2); // one CAR, one stitch block
		const scratch = await reader().restitch(null);
		expect(
			(await mine.readStitch(next)).root.equals(
				(await mine.readStitch(scratch)).root,
			),
		).toBe(true);
	});

	it("a filter keeps only matching repos", async () => {
		await push(mine, PUBLISHER, "a", null);
		await push(theirs, OTHER, "b", null);
		const only = (p: Hex, r: string) => r === "b";
		const s = await mine.restitch(null, only);
		expect(await reader().stitchedHead(s, PUBLISHER, "a")).toBeNull();
		expect(await reader().stitchedHead(s, OTHER, "b")).not.toBeNull();
		expect(await reader().verifyStitch(s, only)).toBe(true);
		expect(await reader().verifyStitch(s)).toBe(false);
	});

	it("verifies against the log root, after the log has moved on", async () => {
		const a1 = await push(mine, PUBLISHER, "a", null);
		const s1 = await mine.restitch(null);
		const { logRoot } = await mine.readStitch(s1);
		expect(logRoot).toMatch(/^0x[0-9a-f]{64}$/);
		await push(mine, PUBLISHER, "a", a1);
		expect(await reader().verifyStitch(s1)).toBe(true);
		const s2 = await mine.restitch(s1);
		expect(await reader().verifyStitch(s2)).toBe(true);
		// an RPC that lies about the log no longer matches the contract's root
		ledger.entries[0] = {
			...ledger.entries[0],
			timestamp: ledger.entries[0].timestamp + 1n,
		};
		expect(await reader().verifyStitch(s2)).toBe(false);
	});

	it("with nothing new in the log, returns the same stitch", async () => {
		await push(mine, PUBLISHER, "a", null);
		const s = await mine.restitch(null);
		expect((await mine.restitch(s)).equals(s)).toBe(true);
	});
});
