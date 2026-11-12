import { describe, it, expect, beforeEach } from "vitest";
import { CID } from "multiformats/cid";
import { FangornEngine, type RecordInput } from "./index.js";
import { decodeBlock, diffMst, encodeBlock } from "./records.js";
import { MemStorage, newRegistry, rootHex } from "./test-helpers.js";

// WHITEPAPER_1 §2: an event is (e, parent, diff, root).

const R = "songs";
const rec = (id: string, v: string): RecordInput => ({
	id,
	type: "t",
	payload: { v },
});

describe("diff events", () => {
	let storage: MemStorage;
	let engine: FangornEngine;
	const commit = async (
		base: CID | null,
		records: RecordInput[],
		deletes: string[] = [],
		replace = false,
	) =>
		(await engine.createCommit({ repo: R, base, records, deletes, replace }))
			.commitCid;

	// what diffMst says changed between two commits: the reference repoDiff must match
	const reference = async (a: CID | null, b: CID) => {
		const root = async (c: CID | null) =>
			c ? (await engine.getCommit(c)).root : null;
		const blocks = await storage.allBlocks();
		const get = (cid: CID) =>
			Promise.resolve(blocks.get(cid.toString()) ?? new Uint8Array());
		const d = await diffMst(await root(a), await root(b), get, get);
		return {
			puts: [...d.puts.keys()].sort(),
			deletes: [...d.deletes].sort(),
			superseded: [...d.before.values()].map(String).sort(),
		};
	};
	const net = async (a: CID | null, b: CID) => {
		const d = await engine.repoDiff(a ? rootHex(a) : null, rootHex(b));
		return {
			puts: d.puts.map((r) => r.id).sort(),
			deletes: [...d.deletes].sort(),
			superseded: [...d.superseded].sort(),
		};
	};

	beforeEach(() => {
		storage = new MemStorage();
		engine = new FangornEngine(storage, newRegistry());
	});

	it("an event's diff holds exactly what changed, deletes as null", async () => {
		const c1 = await commit(null, [rec("t1", "a"), rec("a1", "x")]);
		// t1 changes, a1 goes, b1 is new, and re-putting an identical record is no change
		const c2 = await commit(
			c1,
			[rec("t1", "b"), rec("b1", "y"), rec("keep", "k")],
			["a1"],
		);
		const c3 = await commit(c2, [rec("keep", "k")]);

		const d2 = await engine.eventDiff(c2);
		expect([...d2.keys()].sort()).toEqual(["a1", "b1", "keep", "t1"]);
		expect(d2.get("a1")).toBeNull();
		expect(d2.get("t1")).toBeInstanceOf(CID);
		expect((await engine.eventDiff(c3)).size).toBe(0);
	});

	it("a replace commit deletes every id it doesn't restage", async () => {
		const c1 = await commit(null, [rec("a", "1"), rec("b", "2")]);
		const c2 = await commit(c1, [rec("a", "1")], [], true);
		expect([...(await engine.eventDiff(c2))]).toEqual([["b", null]]);
	});

	it("repoDiff composes events to the same net change as a tree diff", async () => {
		const c1 = await commit(null, [
			rec("a", "1"),
			rec("b", "2"),
			rec("c", "3"),
		]);
		const c2 = await commit(c1, [rec("a", "9"), rec("tmp", "t")], ["b"]);
		// tmp is added and removed again; a goes back to what it was; d is new
		const c3 = await commit(c2, [rec("a", "1"), rec("d", "4")], ["tmp"]);
		const c4 = await commit(c3, [rec("c", "33")]);

		expect(await net(c1, c4)).toEqual(await reference(c1, c4));
		expect(await net(c1, c4)).toEqual({
			puts: ["c", "d"],
			deletes: ["b"],
			superseded: (await reference(c1, c4)).superseded,
		});
		expect(await net(c2, c3)).toEqual(await reference(c2, c3));
		expect(await net(null, c4)).toEqual(await reference(null, c4));
	});

	it("falls back to a tree diff when the old head isn't an ancestor", async () => {
		const x = await commit(null, [rec("a", "1"), rec("b", "2")]);
		const y = await commit(null, [rec("a", "2"), rec("c", "3")]);
		expect(await net(x, y)).toEqual(await reference(x, y));
	});

	it("falls back to a tree diff across a commit without a diff", async () => {
		const c1 = await commit(null, [rec("a", "1")]);
		const c2 = await commit(c1, [rec("b", "2")]);
		// c2 as an older SDK wrote it: no diff field
		const { diff: _, ...fields } = decodeBlock<Record<string, unknown>>(
			storage.blocks.get(c2.toString()) ?? new Uint8Array(),
		);
		const legacy = await encodeBlock(fields);
		storage.blocks.set(legacy.cid.toString(), legacy.bytes);
		expect((await engine.getCommit(legacy.cid)).diff).toBeNull();

		const c3 = await commit(legacy.cid, [rec("c", "3")], ["a"]);
		expect(await net(c1, c3)).toEqual(await reference(c1, c3));
		const show = await engine.diffCommit(legacy.cid);
		expect(show.added).toEqual([`${R}/b`]);
	});

	it("diffCommit reads the event's diff", async () => {
		const c1 = await commit(null, [rec("a", "1"), rec("b", "2")]);
		const c2 = await commit(c1, [rec("a", "9"), rec("c", "3")], ["b"]);
		const show = await engine.diffCommit(c2);
		expect(show.added).toEqual([`${R}/c`]);
		expect(show.updated).toEqual([`${R}/a`]);
		expect(show.removed).toEqual([`${R}/b`]);
	});
});
