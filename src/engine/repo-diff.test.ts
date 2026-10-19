import { describe, it, expect, beforeEach } from "vitest";
import { CID } from "multiformats/cid";
import { FangornEngine, SchemaRegistry, type RecordInput } from "./index.js";
import { buildMst, encodeBlock, lookupMst, readMst, type MstNode } from "./records.js";
import { MemStorage, newRegistry, rootHex } from "./test-helpers.js";

const NS = "songs";

describe("FangornEngine records", () => {
	let engine: FangornEngine;
	let schemas: SchemaRegistry;

	beforeEach(() => {
		schemas = new SchemaRegistry();
		engine = new FangornEngine(
			new MemStorage(),
			schemas,
			newRegistry(),
		);
	});

	async function commit(
		parent: CID | null,
		records: RecordInput[],
		deletes: string[] = [],
	): Promise<CID> {
		const { commitCid } = await engine.createCommit({
			repo: NS,
			base: parent,
			records,
			deletes,
			message: "test",
		});
		return commitCid;
	}

	it("reports puts (with payloads) from a genesis root", async () => {
		const c1 = await commit(null, [
			{ id: "t1", type: "track", payload: { title: "Locura" } },
			{ id: "a1", type: "artist", payload: { name: "Alice" } },
		]);

		const diff = await engine.repoDiff(null, rootHex(c1));
		expect(diff.puts.map((r) => [r.id, r.type]).sort()).toEqual([
			["a1", "artist"],
			["t1", "track"],
		]);
		expect(diff.deletes).toHaveLength(0);
	});

	it("an update keeps the id, changes the cid, and diffs as one put", async () => {
		const c1 = await commit(null, [
			{ id: "t1", type: "track", payload: { title: "Locura", status: "draft" } },
			{ id: "a1", type: "artist", payload: { name: "Alice" } },
		]);
		const c2 = await commit(c1, [
			{ id: "t1", type: "track", payload: { title: "Locura", status: "live" } },
		]);

		const diff = await engine.repoDiff(rootHex(c1), rootHex(c2));
		expect(diff.puts).toHaveLength(1);
		expect(diff.puts[0]).toMatchObject({ id: "t1", payload: { status: "live" } });
		expect(diff.deletes).toHaveLength(0);

		const show = await engine.diffCommit(c2);
		expect(show).toMatchObject({ added: [], updated: [`${NS}/t1`], removed: [] });
	});

	it("deletes by id, and a relation is just a record with refs", async () => {
		const c1 = await commit(null, [
			{ id: "t1", type: "track", payload: { title: "Otra" } },
			{ id: "a1", type: "artist", payload: { name: "Alice" } },
			{ id: "t1>by>a1", type: "by", payload: { src: { local: "t1" }, dst: { local: "a1" } } },
		]);
		const c2 = await commit(c1, [], ["t1>by>a1"]);

		const diff = await engine.repoDiff(rootHex(c1), rootHex(c2));
		expect(diff).toEqual({ puts: [], deletes: ["t1>by>a1"] });
	});

	it("returns an empty diff when the repo slice is untouched", async () => {
		const c1 = await commit(null, [
			{ id: "t1", type: "track", payload: { title: "Locura" } },
		]);
		// re-putting identical content is not a change
		const c2 = await commit(c1, [
			{ id: "t1", type: "track", payload: { title: "Locura" } },
		]);
		expect(await engine.repoDiff(rootHex(c1), rootHex(c2))).toEqual({
			puts: [],
			deletes: [],
		});
	});

	it("a commit can't build on another repo's commit", async () => {
		const c1 = await commit(null, [
			{ id: "t1", type: "track", payload: { title: "Locura" } },
		]);
		await expect(
			engine.createCommit({ repo: "other", base: c1, records: [], message: "x" }),
		).rejects.toThrow(/another repo/);
	});

	it("enforces registered schemas and rejects bad or duplicate ids", async () => {
		schemas.register(NS, { type: "track", requiredFields: ["title"] });
		await expect(commit(null, [{ id: "t1", type: "track", payload: {} }])).rejects.toThrow(/Schema violation/);
		await expect(commit(null, [{ id: "has space", type: "x", payload: {} }])).rejects.toThrow(/invalid record id/);
		await expect(
			commit(null, [
				{ id: "a", type: "x", payload: {} },
				{ id: "a", type: "x", payload: {} },
			]),
		).rejects.toThrow(/staged twice/);
	});

	it("generates an id when none is given", async () => {
		const { recordCids } = await engine.createCommit({
			repo: NS,
			base: null,
			records: [{ type: "note", payload: { body: "hi" } }],
			message: "test",
		});
		expect(Object.keys(recordCids)).toHaveLength(1);
	});
});

describe("Merkle Search Tree", () => {
	const cidFor = async (i: number) => (await encodeBlock({ i })).cid;
	async function state(n: number): Promise<Map<string, CID>> {
		const m = new Map<string, CID>();
		for (let i = 0; i < n; i++) m.set(`k${i.toString()}`, await cidFor(i));
		return m;
	}
	const store = (nodes: { cid: CID; bytes: Uint8Array }[]) => {
		const blocks = new Map(nodes.map((b) => [b.cid.toString(), b.bytes]));
		return (cid: CID) => {
			const b = blocks.get(cid.toString());
			return b ? Promise.resolve(b) : Promise.reject(new Error(`missing ${cid.toString()}`));
		};
	};

	it("the root depends only on the state, not insertion order (Lemma 1)", async () => {
		const s = await state(500);
		const reversed = new Map([...s].reverse());
		expect((await buildMst(s)).root.toString()).toBe((await buildMst(reversed)).root.toString());
	});

	it("an edit rewrites only one path (Lemma 2)", async () => {
		const s = await state(2000);
		const before = await buildMst(s);
		s.set("k42", await cidFor(-1));
		const after = await buildMst(s);
		const old = new Set(before.nodes.map((b) => b.cid.toString()));
		const changed = after.nodes.filter((b) => !old.has(b.cid.toString()));
		expect(after.nodes.length).toBeGreaterThan(100);
		expect(changed.length).toBeLessThanOrEqual(6);
	});

	it("round-trips, and looks up presence and absence", async () => {
		const s = await state(300);
		const { root, nodes } = await buildMst(s);
		const get = store(nodes);
		const back = await readMst(root, get);
		expect([...back.state].map(([k, v]) => [k, v.toString()])).toEqual(
			[...s].map(([k, v]) => [k, v.toString()]).sort(([a], [b]) => (a < b ? -1 : 1)),
		);
		expect((await lookupMst(root, "k7", get))?.toString()).toBe(s.get("k7")?.toString());
		expect(await lookupMst(root, "nope", get)).toBeNull();
	});

	it("rejects a tree that isn't the canonical one for its keys (P2)", async () => {
		const v = await cidFor(0);
		// keys out of order, in one leaf
		const bad = await encodeBlock({
			level: 0,
			left: null,
			entries: [
				{ key: "b", value: v, right: null },
				{ key: "a", value: v, right: null },
			],
		} satisfies MstNode);
		await expect(readMst(bad.cid, store([bad]))).rejects.toThrow(/not canonical/);
	});

	it("refuses graph-era trees", async () => {
		const old = await encodeBlock({ vertices: [], edges: [] });
		await expect(readMst(old.cid, store([old]))).rejects.toThrow(/graph-era/);
	});
});
