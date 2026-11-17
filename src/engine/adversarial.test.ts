import { describe, it, expect } from "vitest";
import { CID } from "multiformats/cid";
import type { Hex } from "viem";
import {
	FangornEngine,
	assertValidRepoName,
	commitUpdate,
	fileCid,
} from "./index.js";
import {
	buildMst,
	decodeBlock,
	diffMst,
	encodeBlock,
	readMst,
	type Block,
	type CommitBlock,
	type MstNode,
} from "./records.js";
import { packCar, readCar } from "./car.js";
import { MemLedger, MemRegistry } from "../test/mem-registry.js";
import { MemStorage } from "./test-helpers.js";

// Inputs a malicious publisher (or a lossy encoder) can produce, and what reads must do with them.

const HONEST = "0x00000000000000000000000000000000000000a1" as Hex;
const EVIL = "0x00000000000000000000000000000000000000e1" as Hex;

function world() {
	const storage = new MemStorage();
	const ledger = new MemLedger();
	const reg = (p: Hex) => new MemRegistry(p, ledger);
	const engine = (p: Hex) => new FangornEngine(storage, reg(p));
	return { storage, ledger, reg, engine };
}

/** Commit `records` as `p`, then rewrite its CAR to also hold `extra`, and settle that. */
async function publishWithExtra(
	w: ReturnType<typeof world>,
	p: Hex,
	repo: string,
	extra: Block[],
): Promise<void> {
	const e = w.engine(p);
	const { commitCid } = await e.createCommit({
		repo,
		base: null,
		records: [{ id: "x", type: "t", payload: { evil: true } }],
	});
	const commit = decodeBlock<CommitBlock>(
		await w.storage.getRawBlock(commitCid.toString()),
	);
	const blocks = await readCar(await w.storage.getFile(commit.car.toString()));
	const car = fileCid(
		await w.storage.putFile(await packCar(commit.root, [...blocks, ...extra])),
	);
	const forged = await encodeBlock({ ...commit, car } satisfies CommitBlock);
	await w.storage.putBlock(forged);
	await w.reg(p).update(commitUpdate({ ...commit, car }));
}

describe("cross-publisher CAR poisoning", () => {
	it("another publisher's CAR claiming an honest block's CID cannot break honest reads", async () => {
		const w = world();
		const { commitCid } = await w.engine(HONEST).createCommit({
			repo: "h",
			base: null,
			records: [
				{ id: "a", type: "t", payload: { v: 1 } },
				{ id: "b", type: "t", payload: { v: 2 } },
			],
		});
		await w.engine(HONEST).pushCommit(HONEST, "h", commitCid);
		const honestA = await w.engine(HONEST).readRecord(HONEST, "h", "a");
		if (!honestA) throw new Error("setup: record a not found");

		// The attacker's CAR carries garbage under the honest record's CID.
		await publishWithExtra(w, EVIL, "evil", [
			{ cid: CID.parse(honestA.cid), bytes: new Uint8Array([0xa0]) },
		]);

		// Order 1: attacker CAR loaded before the honest one.
		const r1 = w.engine(HONEST);
		await r1.listRepo(EVIL, "evil");
		expect(await r1.readRecord(HONEST, "h", "a")).toEqual(honestA);

		// Order 2: honest CAR loaded (block still unverified), then the attacker's.
		const r2 = w.engine(HONEST);
		await r2.readRecord(HONEST, "h", "b");
		await r2.listRepo(EVIL, "evil");
		expect(await r2.readRecord(HONEST, "h", "a")).toEqual(honestA);
	});

	it("a block whose bytes don't hash to its CID, with no good copy anywhere, still fails the read", async () => {
		const w = world();
		const e = w.engine(HONEST);
		const { commitCid } = await e.createCommit({
			repo: "h",
			base: null,
			records: [{ id: "a", type: "t", payload: { v: 1 } }],
		});
		await e.pushCommit(HONEST, "h", commitCid);
		// corrupt every block inside the CAR, keeping the CAR's framing
		for (const [uri, bytes] of w.storage.files) {
			const blocks = await readCar(bytes);
			w.storage.files.set(
				uri,
				await packCar(
					blocks[0].cid,
					blocks.map((b) => ({ cid: b.cid, bytes: b.bytes.map((x) => x ^ 1) })),
				),
			);
		}
		await expect(w.engine(HONEST).readRecord(HONEST, "h", "a")).rejects.toThrow(
			/does not match its content hash/,
		);
	});
});

/** A node repeating one child `fan` times per level: a DAG of `depth` blocks that unrolls to fan^depth nodes. */
async function sharedDag(depth: number) {
	const leaf = await encodeBlock({ v: 0 });
	const blocks = new Map<string, Uint8Array>();
	let child: CID | null = null;
	for (let level = 0; level < depth; level++) {
		const node: MstNode = {
			level,
			left: child,
			entries: [{ key: `k${level.toString()}`, value: leaf.cid, right: child }],
		};
		const b = await encodeBlock(node);
		blocks.set(b.cid.toString(), b.bytes);
		child = b.cid;
	}
	let fetches = 0;
	const get = (cid: CID) => {
		fetches++;
		return Promise.resolve(blocks.get(cid.toString()) ?? new Uint8Array());
	};
	if (!child) throw new Error("depth must be positive");
	return { root: child, get, blocks, fetches: () => fetches };
}

describe("MST reads of a DAG that repeats subtrees", () => {
	it("readMst rejects a repeated node instead of unrolling it exponentially", async () => {
		const dag = await sharedDag(18); // unrolls to ~2^18 node visits
		await expect(readMst(dag.root, dag.get)).rejects.toThrow();
		expect(dag.fetches()).toBeLessThan(100);
	});

	it("diffMst rejects a repeated node instead of unrolling it exponentially", async () => {
		const dag = await sharedDag(18);
		const empty = await buildMst(new Map());
		dag.blocks.set(empty.root.toString(), empty.nodes[0].bytes);
		await expect(
			diffMst(empty.root, dag.root, dag.get, dag.get),
		).rejects.toThrow();
		expect(dag.fetches()).toBeLessThan(100);
	});
});

describe("record ids that are Object.prototype property names", () => {
	it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])(
		"id %s can be staged",
		async (id) => {
			const engine = new FangornEngine(
				new MemStorage(),
				new MemRegistry(HONEST),
			);
			const { commitCid, recordCids } = await engine.createCommit({
				repo: "r",
				base: null,
				records: [{ id, type: "t", payload: { v: 1 } }],
			});
			expect(Object.keys(recordCids)).toEqual([id]);
			const { records } = await engine.listAt(commitCid);
			expect(records.map((r) => r.id)).toEqual([id]);
			expect(records[0].cid).toBe(recordCids[id]);
		},
	);
});

describe("values the encoder cannot store faithfully are rejected, not silently changed", () => {
	const engine = () =>
		new FangornEngine(new MemStorage(), new MemRegistry(HONEST));
	const put = (payload: Record<string, unknown>, type = "t") =>
		engine().createCommit({
			repo: "r",
			base: null,
			records: [{ id: "a", type, payload }],
		});

	it("a payload key __proto__ (as JSON.parse makes) is rejected: it would vanish on read", async () => {
		await expect(
			put(JSON.parse('{"__proto__": {"admin": true}, "v": 1}') as never),
		).rejects.toThrow(/__proto__/);
		await expect(
			put({ nested: JSON.parse('[{"__proto__": 1}]') as unknown }),
		).rejects.toThrow(/__proto__/);
	});

	it("a lone UTF-16 surrogate is rejected: it would read back as U+FFFD", async () => {
		await expect(put({ s: "a\uD800" })).rejects.toThrow(/well-formed/);
		await expect(put({ ["k\uDC00"]: 1 })).rejects.toThrow(/well-formed/);
		await expect(put({ v: 1 }, "t\uD800")).rejects.toThrow(/well-formed/);
	});

	it("a repo name with a lone surrogate is rejected: it collides with its U+FFFD twin on chain", () => {
		expect(() => {
			assertValidRepoName("r\uD800");
		}).toThrow(/well-formed/);
		expect(() => {
			assertValidRepoName("r�");
		}).not.toThrow();
	});

	// Documented dag-cbor normalizations, kept (not rejected): the value is the same number.
	it("-0 reads back as 0 and a safe BigInt as a number", async () => {
		const e = engine();
		const { commitCid } = await e.createCommit({
			repo: "r",
			base: null,
			records: [{ id: "a", type: "t", payload: { z: -0, b: 5n } }],
		});
		const [r] = (await e.listAt(commitCid)).records;
		expect(Object.is(r.payload.z, 0)).toBe(true);
		expect(r.payload.b).toBe(5);
	});
});

describe("event diffs are the publisher's word", () => {
	it("FINDING (design): repoDiff and diffCommit report a diff that disagrees with the commit's own state", async () => {
		const w = world();
		const e = w.engine(HONEST);
		const { commitCid: c1 } = await e.createCommit({
			repo: "r",
			base: null,
			records: [{ id: "a", type: "t", payload: { v: 1 } }],
		});
		await e.pushCommit(HONEST, "r", c1);
		const c1Block = decodeBlock<CommitBlock>(
			await w.storage.getRawBlock(c1.toString()),
		);

		// c2: the same state root, but a diff claiming a record "z" that the state never holds
		const z = await encodeBlock({
			id: "z",
			type: "t",
			payload: { injected: true },
		});
		const diff = await buildMst(new Map([["z", z.cid]]));
		const car = fileCid(
			await w.storage.putFile(await packCar(diff.root, [z, ...diff.nodes])),
		);
		const c2Fields: CommitBlock = {
			...c1Block,
			parent: c1,
			diff: diff.root,
			car,
		};
		const c2 = await encodeBlock(c2Fields);
		await w.storage.putBlock(c2);
		await w.reg(HONEST).update(commitUpdate(c2Fields)); // the contract checks none of it

		const reader = w.engine(HONEST);
		const toHex = (c: CID) => reader.rootHexFromCommitCid(c.toString());
		const d = await reader.repoDiff(toHex(c1), toHex(c2.cid));
		expect(d.puts.map((r) => r.id)).toEqual(["z"]); // a follower indexes "z"...
		expect((await reader.listAt(c2.cid)).records.map((r) => r.id)).toEqual([
			"a",
		]); // ...which isn't there
		expect((await reader.diffCommit(c2.cid)).added).toEqual(["r/z"]);
	});
});

describe("concurrent reads on one engine", () => {
	// fast-check's shrunk counterexample from engine.fuzz.test.ts (repoDiff property, FUZZ_RUNS=600)
	it("a block another in-flight read just loaded is still found", async () => {
		const w = world();
		const e = w.engine(HONEST);
		const recs = (ids: string[], v: number) =>
			ids.map((id) => ({ id, type: "t", payload: { v } }));
		const { commitCid: c1 } = await e.createCommit({
			repo: "r",
			base: null,
			records: recs(
				["id-0", "id-1", "id-4", "id-5", "id-2", "id-6", "id-3", "id-7"],
				0,
			),
		});
		const { commitCid: c2 } = await e.createCommit({
			repo: "r",
			base: c1,
			records: recs(["id-2", "id-0", "id-1"], 1),
		});
		const { commitCid: c3 } = await e.createCommit({
			repo: "r",
			base: c2,
			records: [],
		});
		// the read of c1 loads c1's CAR while the read of c3 is between hops
		const reader = w.engine(HONEST);
		const got = await Promise.all([c1, c2, c3].map((c) => reader.listAt(c)));
		expect(got.map((s) => s.records.length)).toEqual([8, 8, 8]);
	});
});
