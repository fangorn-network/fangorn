import { describe, it, expect, beforeAll } from "vitest";
import { CID } from "multiformats/cid";
import { FangornEngine, type RecordInput } from "./index.js";
import {
	buildMst,
	encodeBlock,
	isRecordBlock,
	keyLevel,
	readMst,
	walkMst,
	type MstNode,
} from "./records.js";
import { packCar, readCar } from "./car.js";
import { MemStorage, newRegistry, rootHex } from "./test-helpers.js";

// Reading a big repo a range at a time (walkMst, entriesAt) and without holding its records
// (leanCars, getRecords): what a Worker with 128 MB needs to index a 50k-record commit.

const value = (n: number) => encodeBlock({ n }).then((b) => b.cid); // any CID will do as an MST value

/** An MST over `keys`, its blocks in a map, and a getBlock that counts reads. */
async function tree(keys: string[]) {
	const state = new Map<string, CID>();
	for (const [i, k] of keys.entries()) state.set(k, await value(i));
	const { root, nodes } = await buildMst(state);
	const blocks = new Map(nodes.map((b) => [b.cid.toString(), b.bytes]));
	const counter = { reads: 0 };
	const get = (cid: CID) => {
		counter.reads++;
		const b = blocks.get(cid.toString());
		return b
			? Promise.resolve(b)
			: Promise.reject(new Error(`no ${cid.toString()}`));
	};
	return { root, blocks, state, get, counter };
}

async function walk(
	root: CID,
	get: (c: CID) => Promise<Uint8Array>,
	after?: string | null,
) {
	const out: [string, string][] = [];
	for await (const [k, v] of walkMst(root, get, { after }))
		out.push([k, v.toString()]);
	return out;
}

const sorted = (state: Map<string, CID>) =>
	[...state]
		.map(([k, v]): [string, string] => [k, v.toString()])
		.sort((a, b) => (a[0] < b[0] ? -1 : 1));

/** `n` keys whose MST level is `level`. */
function keysAt(level: number, n: number, prefix = "k"): string[] {
	const out: string[] = [];
	for (let i = 0; out.length < n; i++)
		if (keyLevel(`${prefix}${i.toString()}`) === level)
			out.push(`${prefix}${i.toString()}`);
	return out.sort();
}

describe("walkMst", () => {
	it("reads what readMst reads, in key order", async () => {
		for (const n of [0, 1, 2, 50, 2000]) {
			const t = await tree(
				Array.from({ length: n }, (_, i) => `rec-${i.toString()}`),
			);
			const all = await walk(t.root, t.get);
			expect(all).toEqual(sorted(t.state));
			expect(all).toEqual(sorted((await readMst(t.root, t.get)).state));
		}
	});

	it("resumes after any cursor: a key, a gap, before the first, past the last", async () => {
		const t = await tree(
			Array.from({ length: 500 }, (_, i) => `rec-${i.toString()}`),
		);
		const all = sorted(t.state);
		for (const after of [
			all[0][0],
			all[137][0],
			`${all[300][0]}-`,
			all[499][0],
			"!",
			"~",
		]) {
			expect(await walk(t.root, t.get, after)).toEqual(
				all.filter(([k]) => k > after),
			);
		}
	});

	it("reads only the path it is on: a few entries cost a few nodes", async () => {
		const t = await tree(
			Array.from({ length: 2000 }, (_, i) => `rec-${i.toString()}`),
		);
		const all = sorted(t.state);
		let n = 0;
		for await (const _ of walkMst(t.root, t.get, { after: all[1000][0] }))
			if (++n === 5) break;
		expect(t.counter.reads).toBeLessThan(15);
		expect(t.blocks.size).toBeGreaterThan(100);
	});

	describe("refuses a tree buildMst wouldn't make", () => {
		const put = async (blocks: Map<string, Uint8Array>, node: unknown) => {
			const b = await encodeBlock(node);
			blocks.set(b.cid.toString(), b.bytes);
			return b.cid;
		};
		let v: CID;
		beforeAll(async () => {
			v = await value(0);
		});
		/** The walk over the tree `build` makes, its root's blocks in a map. */
		const walkOf = async (
			build: (blocks: Map<string, Uint8Array>) => Promise<CID>,
		) => {
			const blocks = new Map<string, Uint8Array>();
			const root = await build(blocks);
			return walk(root, (c) =>
				Promise.resolve(blocks.get(c.toString()) ?? new Uint8Array()),
			);
		};
		const leaf = (keys: string[]): MstNode => ({
			level: 0,
			left: null,
			entries: keys.map((key) => ({ key, value: v, right: null })),
		});

		it("keys out of order", async () => {
			const [a, b] = keysAt(0, 2);
			await expect(walkOf((m) => put(m, leaf([b, a])))).rejects.toThrow(
				/out of order/,
			);
			await expect(walkOf((m) => put(m, leaf([a, a])))).rejects.toThrow(
				/out of order/,
			);
		});
		it("a key at the wrong level", async () => {
			await expect(
				walkOf((m) => put(m, leaf([...keysAt(0, 1), ...keysAt(1, 1, "z")]))),
			).rejects.toThrow(/at level 0/);
		});
		it("a key that isn't a record id", async () => {
			await expect(walkOf((m) => put(m, leaf(["has space"])))).rejects.toThrow(
				/not a record id/,
			);
		});
		it("a child outside its parent's bounds", async () => {
			const [top] = keysAt(1, 1);
			const above = keysAt(0, 1, `${top}~`); // sorts after `top`, but filed on its left
			await expect(
				walkOf(async (m) =>
					put(m, {
						level: 1,
						left: await put(m, leaf(above)),
						entries: [{ key: top, value: v, right: null }],
					}),
				),
			).rejects.toThrow(/out of order/);
		});
		it("a child at the wrong level", async () => {
			const [top] = keysAt(2, 1);
			await expect(
				walkOf(async (m) =>
					put(m, {
						level: 2,
						left: await put(m, leaf(keysAt(0, 1, "a"))),
						entries: [{ key: top, value: v, right: null }],
					}),
				),
			).rejects.toThrow(/level 0, not 1/);
		});
		it("children under level 0", async () => {
			const [a] = keysAt(0, 1);
			await expect(
				walkOf(async (m) =>
					put(m, { ...leaf([a]), left: await put(m, leaf(keysAt(0, 1, "0"))) }),
				),
			).rejects.toThrow(/level 0 with children/);
		});
		it("an empty node below the root", async () => {
			const [top] = keysAt(1, 1);
			await expect(
				walkOf(async (m) =>
					put(m, {
						level: 1,
						left: await put(m, leaf([])),
						entries: [{ key: top, value: v, right: null }],
					}),
				),
			).rejects.toThrow(/is empty/);
		});
		it("a root with no key of its own", async () => {
			await expect(
				walkOf(async (m) =>
					put(m, {
						level: 1,
						left: await put(m, leaf(keysAt(0, 2))),
						entries: [],
					}),
				),
			).rejects.toThrow(/root without a key/);
		});
	});
});

describe("isRecordBlock", () => {
	it("tells records from tree nodes and commits by their first bytes", async () => {
		const rec = await encodeBlock({ id: "a", type: "t", payload: { x: 1 } });
		expect(isRecordBlock(rec.bytes)).toBe(true);
		const t = await tree(["a", "b", "c"]);
		for (const bytes of t.blocks.values())
			expect(isRecordBlock(bytes)).toBe(false);
		const commit = await encodeBlock({
			car: t.root,
			diff: null,
			epoch: 1,
			parent: null,
			repo: "r",
			root: t.root,
		});
		expect(isRecordBlock(commit.bytes)).toBe(false);
	});
});

describe("leanCars", () => {
	const REPO = "tracks";
	const rec = (i: number, v = 1): RecordInput => ({
		id: `t-${i.toString().padStart(4, "0")}`,
		type: "track",
		payload: { i, v, title: `track ${i.toString()}` },
	});
	let storage: MemStorage;
	let registry: ReturnType<typeof newRegistry>;
	let first: CID, tip: CID;

	// one big commit, then a delta: 20 changed, 5 deleted, 10 new
	beforeAll(async () => {
		storage = new MemStorage();
		registry = newRegistry();
		const writer = new FangornEngine(storage, registry);
		first = (
			await writer.createCommit({
				repo: REPO,
				base: null,
				records: Array.from({ length: 300 }, (_, i) => rec(i)),
			})
		).commitCid;
		tip = (
			await writer.createCommit({
				repo: REPO,
				base: first,
				records: [
					...Array.from({ length: 20 }, (_, i) => rec(i * 10, 2)),
					...Array.from({ length: 10 }, (_, i) => rec(300 + i)),
				],
				deletes: Array.from({ length: 5 }, (_, i) => rec(i * 10 + 5).id ?? ""),
			})
		).commitCid;
	});

	const entries = async (e: FangornEngine, at: CID, after?: string) => {
		const out: [string, CID][] = [];
		for await (const kv of e.entriesAt(at, { after })) out.push(kv);
		return out;
	};
	const internals = (e: FangornEngine) =>
		e as unknown as {
			unverified: Map<string, Uint8Array>;
			cache: Map<string, Uint8Array>;
			skipped: Map<string, string>;
		};

	it("walks the tree without loading a record", async () => {
		const lean = new FangornEngine(storage, registry, { leanCars: true });
		const got = await entries(lean, tip);
		expect(got.map(([k, c]) => [k, c.toString()])).toEqual(
			(await entries(new FangornEngine(storage, registry), tip)).map(
				([k, c]) => [k, c.toString()],
			),
		);
		expect(got).toHaveLength(305);
		const { unverified, cache, skipped } = internals(lean);
		expect(
			[...unverified.values(), ...cache.values()].some(isRecordBlock),
		).toBe(false);
		expect(skipped.size).toBeGreaterThan(0);
	});

	it("getRecords fetches a range in one pass per CAR, ending each download once it has them", async () => {
		const lean = new FangornEngine(storage, registry, { leanCars: true });
		const all = await entries(lean, tip);
		const full = new FangornEngine(storage, registry);
		const want = all.slice(40, 60);
		storage.streams = storage.streamsEndedEarly = 0;
		const got = await lean.getRecords(want, tip);
		expect(got).toEqual(await full.getRecords(want, tip));
		expect(got.map((r) => r.id)).toEqual(want.map(([id]) => id));
		// the range spans both CARs (changed records are in the delta's), one stream each, both ended early
		expect(storage.streams).toBe(2);
		expect(storage.streamsEndedEarly).toBe(2);
	});

	it("getRecords finds records in CARs the walk never loaded", async () => {
		const lean = new FangornEngine(storage, registry, { leanCars: true });
		const [unchanged] = (
			await entries(new FangornEngine(storage, registry), tip)
		).filter(([id]) => id === "t-0001");
		const [r] = await lean.getRecords([unchanged], tip); // no walk first: both CARs still unloaded
		expect(r.payload).toEqual({ i: 1, v: 1, title: "track 1" });
	});

	it("reads records one at a time by loading their CAR in full (getBlock's fallback)", async () => {
		const lean = new FangornEngine(storage, registry, { leanCars: true });
		await entries(lean, tip);
		// repoDiff decodes each record with getBlock: each CAR is loaded again, records included, once
		const diff = await lean.repoDiff(null, rootHex(tip));
		const ref = await new FangornEngine(storage, registry).repoDiff(
			null,
			rootHex(tip),
		);
		const byId = (rs: { id: string }[]) =>
			[...rs].sort((a, b) => (a.id < b.id ? -1 : 1));
		expect(byId(diff.puts)).toEqual(byId(ref.puts));
		expect(diff.puts).toHaveLength(305);
		expect(internals(lean).skipped.size).toBe(0);
	});

	it("diffEntriesAt streams a commit's diff event, deletes as null", async () => {
		const lean = new FangornEngine(storage, registry, { leanCars: true });
		const got: [string, string | null][] = [];
		for await (const [id, cid] of lean.diffEntriesAt(tip))
			got.push([id, cid?.toString() ?? null]);
		const ref = [...(await new FangornEngine(storage, registry).eventDiff(tip))]
			.map(([id, cid]): [string, string | null] => [
				id,
				cid?.toString() ?? null,
			])
			.sort((a, b) => (a[0] < b[0] ? -1 : 1));
		expect(got).toEqual(ref);
		expect(got.filter(([, c]) => c === null)).toHaveLength(5);
		expect(got).toHaveLength(35);
		const after = got[10][0];
		const rest: string[] = [];
		for await (const [id] of lean.diffEntriesAt(tip, { after })) rest.push(id);
		expect(rest).toEqual(got.slice(11).map(([id]) => id));
		// a repo's first commit has one too: every record, put
		let genesis = 0;
		for await (const [, cid] of lean.diffEntriesAt(first)) if (cid) genesis++;
		expect(genesis).toBe(300);
	});

	it("gives the same answers without a streaming storage", async () => {
		const plain = new MemStorage();
		plain.blocks = storage.blocks;
		plain.files = storage.files;
		(plain as { getFileStream?: unknown }).getFileStream = undefined;
		const lean = new FangornEngine(plain, registry, { leanCars: true });
		const all = await entries(lean, tip);
		expect(await lean.getRecords(all.slice(0, 50), tip)).toEqual(
			await new FangornEngine(storage, registry).getRecords(
				all.slice(0, 50),
				tip,
			),
		);
	});

	it("refuses a record whose bytes don't match its CID", async () => {
		const bad = new MemStorage();
		bad.blocks = storage.blocks;
		bad.files = new Map(storage.files);
		const all = await entries(new FangornEngine(storage, registry), first);
		const target = all[7][1].toString();
		// the same CAR, with that record's bytes swapped for another record's, under the old CID
		const forged = (
			await encodeBlock({
				id: all[7][0],
				type: "track",
				payload: { forged: true },
			})
		).bytes;
		for (const [uri, bytes] of bad.files) {
			const blocks = await readCar(bytes, { verify: false });
			if (!blocks.some((b) => b.cid.toString() === target)) continue;
			const swapped = blocks.map((b) =>
				b.cid.toString() === target ? { cid: b.cid, bytes: forged } : b,
			);
			bad.files.set(uri, await packCar(blocks[0].cid, swapped));
		}
		const lean = new FangornEngine(bad, registry, { leanCars: true });
		await expect(lean.getRecords([all[7]], first)).rejects.toThrow(
			/does not match its content hash/,
		);
		await expect(
			new FangornEngine(bad, registry, { leanCars: true }).getRecords(
				[all[8]],
				first,
			),
		).resolves.toHaveLength(1);
	});
});
