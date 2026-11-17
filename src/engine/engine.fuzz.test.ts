import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";
import { sha256 } from "@noble/hashes/sha2.js";
import { FangornEngine, type RecordInput, type StoredRecord } from "./index.js";
import {
	buildMst,
	diffMst,
	readMst,
	assertValidRecordId,
	type Block,
} from "./records.js";
import { readCar, packCar } from "./car.js";
import { MemStorage, newRegistry, rootHex, PUBLISHER } from "./test-helpers.js";

// Property tests for the engine: the MST is a function of the record set, diffs compose
// back to the state they describe, payloads round-trip, bad input leaves no trace, and a
// tampered host never yields wrong data. FUZZ_RUNS=<n> for a longer campaign.

const runs = (n: number) => Number(process.env.FUZZ_RUNS ?? n);
const opts = (seed: number, n: number) => ({ seed, numRuns: runs(n) });

const enc = new TextEncoder();
const cidOf = (s: string) =>
	CID.createV1(0x71, Digest.create(0x12, sha256(enc.encode(s))));

const idArb = fc.string({
	unit: fc.integer({ min: 0x21, max: 0x7e }).map((c) => String.fromCharCode(c)),
	minLength: 1,
	maxLength: 10,
});

/** A small id pool so ops collide: puts overwrite, deletes hit. */
const poolId = fc.integer({ min: 0, max: 24 }).map((i) => `id-${i.toString()}`);

/** A state as key → value CID. */
const stateArb = fc
	.uniqueArray(fc.tuple(idArb, fc.nat(50)), {
		selector: ([k]) => k,
		maxLength: 120,
	})
	.map((kv) => new Map(kv.map(([k, v]) => [k, cidOf(`${k}:${v.toString()}`)])));

const blockStore = (nodes: Block[]) => {
	const m = new Map(nodes.map((n) => [n.cid.toString(), n.bytes]));
	return (cid: CID) => {
		const b = m.get(cid.toString());
		return b ? Promise.resolve(b) : Promise.reject(new Error("missing"));
	};
};

/** The naive diff of two maps, for comparison with diffMst. */
function naiveDiff(a: Map<string, CID>, b: Map<string, CID>) {
	const puts = new Map<string, string>();
	const before = new Map<string, string>();
	const deletes: string[] = [];
	for (const [k, v] of b)
		if (!a.get(k)?.equals(v)) {
			puts.set(k, v.toString());
			const old = a.get(k);
			if (old) before.set(k, old.toString());
		}
	for (const [k, v] of a)
		if (!b.has(k)) {
			deletes.push(k);
			before.set(k, v.toString());
		}
	return { puts, before, deletes: deletes.sort() };
}

const str = (m: Map<string, CID>) =>
	new Map([...m].map(([k, v]) => [k, v.toString()]));

describe("MST properties (records.ts)", () => {
	it("the root depends only on the key set: any insertion order, same root and nodes", async () => {
		await fc.assert(
			fc.asyncProperty(
				stateArb.chain((s) =>
					fc.tuple(
						fc.constant(s),
						fc.shuffledSubarray([...s], { minLength: s.size }),
					),
				),
				async ([state, shuffled]) => {
					const a = await buildMst(state);
					const b = await buildMst(new Map(shuffled));
					expect(b.root.toString()).toBe(a.root.toString());
					expect(new Set(b.nodes.map((n) => n.cid.toString()))).toEqual(
						new Set(a.nodes.map((n) => n.cid.toString())),
					);
				},
			),
			opts(0x5eed01, 150),
		);
	});

	it("readMst(buildMst(s)) is s, and visits exactly the built nodes", async () => {
		await fc.assert(
			fc.asyncProperty(stateArb, async (state) => {
				const { root, nodes } = await buildMst(state);
				const back = await readMst(root, blockStore(nodes));
				expect(str(back.state)).toEqual(str(state));
				expect(back.nodeCids).toEqual(
					new Set(nodes.map((n) => n.cid.toString())),
				);
			}),
			opts(0x5eed02, 150),
		);
	});

	it("diffMst(A, B) is the naive map diff, and applying it to A gives B", async () => {
		await fc.assert(
			fc.asyncProperty(
				stateArb,
				fc.array(fc.tuple(fc.oneof(idArb, poolId), fc.option(fc.nat(50))), {
					maxLength: 40,
				}),
				async (a, edits) => {
					const b = new Map(a);
					// edit existing keys too, not just random ones
					const keys = [...a.keys()];
					for (const [i, [k, v]] of edits.entries()) {
						const key = keys.length && i % 2 ? keys[i % keys.length] : k;
						if (v === null) b.delete(key);
						else b.set(key, cidOf(`${key}:${v.toString()}`));
					}
					const ta = await buildMst(a);
					const tb = await buildMst(b);
					const d = await diffMst(
						ta.root,
						tb.root,
						blockStore(ta.nodes),
						blockStore(tb.nodes),
					);
					const want = naiveDiff(a, b);
					expect(str(d.puts)).toEqual(want.puts);
					expect(str(d.before)).toEqual(want.before);
					expect([...d.deletes].sort()).toEqual(want.deletes);

					const applied = new Map<string, CID>(a);
					for (const k of d.deletes) applied.delete(k);
					for (const [k, v] of d.puts) applied.set(k, v);
					expect(str(applied)).toEqual(str(b));
				},
			),
			opts(0x5eed03, 150),
		);
	});

	it("readMst rejects any single-byte change to any node (hash-checked store)", async () => {
		await fc.assert(
			fc.asyncProperty(
				stateArb.filter((s) => s.size > 0),
				fc.nat(),
				fc.nat(),
				fc.integer({ min: 1, max: 255 }),
				async (state, which, at, xor) => {
					const { root, nodes } = await buildMst(state);
					const n = nodes[which % nodes.length];
					const bad = n.bytes.slice();
					bad[at % bad.length] ^= xor;
					// fed unchecked bytes, readMst's rebuild-and-compare must still refuse any other state
					const get = (cid: CID) =>
						cid.equals(n.cid) ? Promise.resolve(bad) : blockStore(nodes)(cid);
					const res = await readMst(root, get).then(
						(r) => r.state,
						() => null,
					);
					expect(res ? str(res) : str(state)).toEqual(str(state)); // refused, or exact
				},
			),
			opts(0x5eed04, 150),
		);
	});
});

// ── Engine-level ──────────────────────────────────────────────────────────────

interface Op {
	puts: { id: string; v: number }[];
	deletes: string[];
	replace: boolean;
}

const opArb: fc.Arbitrary<Op> = fc.record({
	puts: fc.uniqueArray(fc.record({ id: poolId, v: fc.nat(5) }), {
		selector: (p) => p.id,
		maxLength: 8,
	}),
	deletes: fc.array(poolId, { maxLength: 4 }),
	replace: fc.constant(false),
});
/** A few ops in a row, one in eight a `replace` snapshot. */
const opsArb = fc.array(
	fc.tuple(opArb, fc.nat(7)).map(([o, r]) => ({ ...o, replace: r === 0 })),
	{ minLength: 1, maxLength: 6 },
);

const toRecords = (puts: Op["puts"]): RecordInput[] =>
	puts.map((p) => ({ id: p.id, type: "t", payload: { v: p.v } }));

function applyModel(model: Map<string, number>, op: Op) {
	const next = op.replace ? new Map<string, number>() : new Map(model);
	if (!op.replace) for (const id of op.deletes) next.delete(id);
	for (const p of op.puts) next.set(p.id, p.v);
	return next;
}

const asModel = (records: StoredRecord[]) =>
	new Map(records.map((r) => [r.id, r.payload.v as number]));

function engine(storage = new MemStorage()) {
	const registry = newRegistry();
	return { storage, registry, engine: new FangornEngine(storage, registry) };
}

describe("engine properties (index.ts)", () => {
	it("history independence: any op sequence ends at the root of one commit of the final state", async () => {
		await fc.assert(
			fc.asyncProperty(opsArb, fc.nat(), async (ops, shuffleSeed) => {
				const { engine: e } = engine();
				let model = new Map<string, number>();
				let base: CID | null = null;
				let root: CID | null = null;
				for (const op of ops) {
					({ commitCid: base, root } = await e.createCommit({
						repo: "r",
						base,
						records: toRecords(op.puts),
						deletes: op.deletes,
						replace: op.replace,
					}));
					model = applyModel(model, op);
				}
				// the final state as one batch, in some other order
				const entries = [...model].map(([id, v]) => ({ id, v }));
				const cut = entries.length ? shuffleSeed % entries.length : 0;
				entries.push(...entries.splice(0, cut));
				if (shuffleSeed % 2) entries.reverse();
				const { root: oneShot } = await engine().engine.createCommit({
					repo: "r",
					base: null,
					records: toRecords(entries),
				});
				expect(root?.toString()).toBe(oneShot.toString());
				expect(asModel((await e.listAt(base)).records)).toEqual(model);
			}),
			opts(0x5eed10, 60),
		);
	});

	it("repoDiff(old, new) applied to old's records is new's records: event path and tree path", async () => {
		await fc.assert(
			fc.asyncProperty(opsArb, async (ops) => {
				const storage = new MemStorage();
				const { engine: e } = engine(storage);
				const commits: CID[] = [];
				let base: CID | null = null;
				for (const op of ops) {
					({ commitCid: base } = await e.createCommit({
						repo: "r",
						base,
						records: toRecords(op.puts),
						deletes: op.deletes,
						replace: op.replace,
					}));
					commits.push(base);
				}
				// a fresh reader over the same storage: nothing cached
				const reader = new FangornEngine(storage, newRegistry());
				const states = await Promise.all(
					commits.map(async (c) => (await reader.listAt(c)).records),
				);
				const check = async (i: number | null, j: number) => {
					const before = i === null ? [] : states[i];
					const d = await reader.repoDiff(
						i === null ? null : rootHex(commits[i]),
						rootHex(commits[j]),
					);
					const got = new Map(before.map((r) => [r.id, r]));
					for (const id of d.deletes) got.delete(id);
					for (const r of d.puts) got.set(r.id, r);
					expect(new Map([...got].map(([k, r]) => [k, r.cid]))).toEqual(
						new Map(states[j].map((r) => [r.id, r.cid])),
					);
					// superseded: exactly the old CIDs of deleted or replaced records
					const after = new Map(states[j].map((r) => [r.id, r.cid]));
					const want = before
						.filter((r) => after.get(r.id) !== r.cid)
						.map((r) => r.cid)
						.sort();
					expect([...d.superseded].sort()).toEqual(want);
				};
				for (let j = 0; j < commits.length; j++) {
					await check(null, j);
					for (let i = 0; i < commits.length; i++) await check(i, j); // i > j: tree path
				}
			}),
			opts(0x5eed11, 40),
		);
	});

	it("a commit's event diff is exactly the change from its parent's state", async () => {
		await fc.assert(
			fc.asyncProperty(opsArb, async (ops) => {
				const { engine: e } = engine();
				let base: CID | null = null;
				let model = new Map<string, number>();
				let prevCids = new Map<string, string>();
				for (const op of ops) {
					({ commitCid: base } = await e.createCommit({
						repo: "r",
						base,
						records: toRecords(op.puts),
						deletes: op.deletes,
						replace: op.replace,
					}));
					model = applyModel(model, op);
					const cids = new Map(
						(await e.listAt(base)).records.map((r) => [r.id, r.cid]),
					);
					const want = new Map<string, string | null>();
					for (const [id, c] of cids)
						if (prevCids.get(id) !== c) want.set(id, c);
					for (const id of prevCids.keys())
						if (!cids.has(id)) want.set(id, null);
					const got = new Map(
						[...(await e.eventDiff(base))].map(([k, v]) => [
							k,
							v?.toString() ?? null,
						]),
					);
					expect(got).toEqual(want);
					prevCids = cids;
				}
			}),
			opts(0x5eed12, 60),
		);
	});

	it("checkpoints hold the whole state: readable with every older CAR gone", async () => {
		await fc.assert(
			fc.asyncProperty(opsArb, opsArb, async (before, after) => {
				const storage = new MemStorage();
				const { engine: e } = engine(storage);
				let base: CID | null = null;
				let model = new Map<string, number>();
				for (const op of before) {
					({ commitCid: base } = await e.createCommit({
						repo: "r",
						base,
						records: toRecords(op.puts),
						deletes: op.deletes,
					}));
					model = applyModel(model, { ...op, replace: false });
				}
				const older = new Set(storage.files.keys());
				const { commitCid: cp } = await e.createCommit({
					repo: "r",
					base,
					records: [],
					checkpoint: true,
				});
				base = cp;
				const live = [cp];
				for (const op of after) {
					({ commitCid: base } = await e.createCommit({
						repo: "r",
						base,
						records: toRecords(op.puts),
						deletes: op.deletes,
					}));
					live.push(base);
					model = applyModel(model, { ...op, replace: false });
				}
				// drop every CAR from before the checkpoint (storage dedups: a later commit may reuse one)
				for (const c of live)
					older.delete((await e.getCommit(c)).car.toString());
				for (const uri of older) storage.files.delete(uri);
				const reader = new FangornEngine(storage, newRegistry());
				expect(asModel((await reader.listAt(base)).records)).toEqual(model);
			}),
			opts(0x5eed13, 40),
		);
	});

	it("re-putting identical records leaves the root unchanged", async () => {
		await fc.assert(
			fc.asyncProperty(opArb, async (op) => {
				const { engine: e } = engine();
				const a = await e.createCommit({
					repo: "r",
					base: null,
					records: toRecords(op.puts),
				});
				const b = await e.createCommit({
					repo: "r",
					base: a.commitCid,
					records: toRecords(op.puts),
					deletes: ["never-existed"],
				});
				expect(b.root.toString()).toBe(a.root.toString());
				expect((await e.eventDiff(b.commitCid)).size).toBe(0);
			}),
			opts(0x5eed14, 60),
		);
	});

	it("invalid input is rejected with no upload and no change to what the base reads as", async () => {
		const badRecord = fc.oneof(
			fc.constant<RecordInput>({ id: "", type: "t", payload: {} }),
			fc.constant<RecordInput>({ id: "has space", type: "t", payload: {} }),
			fc.constant<RecordInput>({ id: "x".repeat(257), type: "t", payload: {} }),
			fc.constant<RecordInput>({ id: "é", type: "t", payload: {} }),
			fc.constant<RecordInput>({
				id: "u",
				type: "t",
				payload: { n: undefined },
			}),
			fc.constant<RecordInput>({ id: "n", type: "t", payload: { n: NaN } }),
			fc.constant<RecordInput>({
				id: "d",
				type: "t",
				payload: { d: new Date(0) },
			}),
			fc.constant<RecordInput>({
				id: "s",
				type: "t",
				payload: { s: "\uD800" },
			}),
		);
		await fc.assert(
			fc.asyncProperty(
				opArb,
				opArb,
				badRecord,
				fc.nat(),
				async (op1, op2, bad, at) => {
					const { engine: e, storage } = engine();
					const { commitCid } = await e.createCommit({
						repo: "r",
						base: null,
						records: toRecords(op1.puts),
					});
					const snapshot = (await e.listAt(commitCid)).records;
					const writes = storage.writes;
					const records = toRecords(op2.puts);
					records.splice(at % (records.length + 1), 0, bad);
					// also: the same id twice in one batch
					const dup = records.length > 1 ? [...records, records[0]] : records;
					for (const batch of [records, dup])
						await expect(
							e.createCommit({ repo: "r", base: commitCid, records: batch }),
						).rejects.toThrow();
					expect(storage.writes).toBe(writes);
					expect((await e.listAt(commitCid)).records).toEqual(snapshot);
				},
			),
			opts(0x5eed15, 60),
		);
	});
});

// ── Payload round trip ───────────────────────────────────────────────────────

/** Values dag-cbor stores exactly (no -0, no BigInt, no lone surrogates, no `__proto__` key). */
const { value: payloadValue } = fc.letrec((tie) => ({
	value: fc.oneof(
		{ depthSize: "small" },
		fc.string({ unit: "binary" }),
		fc.maxSafeInteger(),
		fc
			.double({ noNaN: true, noDefaultInfinity: true })
			.filter((d) => !Object.is(d, -0)),
		fc.boolean(),
		fc.constant(null),
		fc.uint8Array({ maxLength: 16 }),
		fc.constant(cidOf("linked")),
		fc.array(tie("value"), { maxLength: 4 }),
		tie("object"),
	),
	object: fc.dictionary(
		fc
			.string({ unit: "binary", maxLength: 8 })
			.filter((k) => k !== "__proto__"),
		tie("value"),
		{ maxKeys: 5 },
	),
}));

describe("payload round trip", () => {
	it("put then read returns the payload exactly (fresh reader, through CAR)", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.uniqueArray(
					fc.record({
						id: idArb,
						type: fc.string({ unit: "binary", maxLength: 12 }),
						payload: fc.dictionary(
							fc
								.string({ unit: "binary", maxLength: 8 })
								.filter((k) => k !== "__proto__"),
							payloadValue,
							{ maxKeys: 6 },
						),
					}),
					{ selector: (r) => r.id, minLength: 1, maxLength: 6 },
				),
				async (records) => {
					const storage = new MemStorage();
					const { engine: e, registry } = engine(storage);
					const { commitCid } = await e.createCommit({
						repo: "r",
						base: null,
						records,
					});
					await e.pushCommit(PUBLISHER, "r", commitCid);
					const reader = new FangornEngine(storage, registry);
					for (const r of records) {
						const got = await reader.readRecord(PUBLISHER, "r", r.id);
						expect(got?.type).toBe(r.type);
						expect(got?.payload).toEqual(r.payload);
					}
				},
			),
			opts(0x5eed20, 100),
		);
	});
});

// ── Tampering host ───────────────────────────────────────────────────────────

describe("a host that flips a byte never makes a read return wrong data", () => {
	it("any byte of any stored block or CAR: the read fails or matches the honest read", async () => {
		await fc.assert(
			fc.asyncProperty(
				opsArb,
				fc.nat(),
				fc.nat(),
				fc.integer({ min: 1, max: 255 }),
				fc.boolean(),
				async (ops, which, at, xor, insideCar) => {
					const storage = new MemStorage();
					const { engine: e, registry } = engine(storage);
					let base: CID | null = null;
					for (const op of ops) {
						({ commitCid: base } = await e.createCommit({
							repo: "r",
							base,
							records: toRecords(op.puts),
							deletes: op.deletes,
							replace: op.replace,
						}));
						await e.pushCommit(PUBLISHER, "r", base);
					}
					const honest = await new FangornEngine(storage, registry).listRepo(
						PUBLISHER,
						"r",
					);

					if (insideCar) {
						// keep the CAR well-formed, corrupt one block's bytes
						const uris = [...storage.files.keys()];
						const uri = uris[which % uris.length];
						const blocks = await readCar(await storage.getFile(uri));
						if (blocks.length === 0) return;
						const b = blocks[at % blocks.length];
						const bytes = b.bytes.slice();
						bytes[(at >> 3) % bytes.length] ^= xor;
						blocks[at % blocks.length] = { cid: b.cid, bytes };
						storage.files.set(uri, await packCar(blocks[0].cid, blocks));
					} else {
						const all = [...storage.blocks, ...storage.files];
						const [uri, bytes] = all[which % all.length];
						const bad = bytes.slice();
						bad[at % bad.length] ^= xor;
						(storage.blocks.has(uri) ? storage.blocks : storage.files).set(
							uri,
							bad,
						);
					}

					const reader = new FangornEngine(storage, registry);
					const got = await reader.listRepo(PUBLISHER, "r").then(
						(r) => r,
						() => null,
					);
					expect(got ?? honest).toEqual(honest); // refused, or exact
				},
			),
			opts(0x5eed30, 100),
		);
	});

	it("a host serving another block's bytes for a CID is refused", async () => {
		const storage = new MemStorage();
		const { engine: e, registry } = engine(storage);
		const a = await e.createCommit({
			repo: "r",
			base: null,
			records: [{ id: "a", type: "t", payload: {} }],
		});
		await e.pushCommit(PUBLISHER, "r", a.commitCid);
		const b = await e.createCommit({
			repo: "r",
			base: a.commitCid,
			records: [],
		});
		// the head now names commit a, but the host answers with commit b's block
		storage.blocks.set(
			a.commitCid.toString(),
			await storage.getRawBlock(b.commitCid.toString()),
		);
		await expect(
			new FangornEngine(storage, registry).listRepo(PUBLISHER, "r"),
		).rejects.toThrow(/does not match its content hash/);
	});
});

describe("record ids (assertValidRecordId)", () => {
	it("accepts exactly 1-256 printable ASCII characters", () => {
		fc.assert(
			fc.property(fc.string({ unit: "binary", maxLength: 300 }), (id) => {
				const ok =
					id.length >= 1 && id.length <= 256 && /^[\x21-\x7e]+$/.test(id);
				let accepted = true;
				try {
					assertValidRecordId(id);
				} catch {
					accepted = false;
				}
				expect(accepted).toBe(ok);
			}),
			opts(0x5eed40, 200),
		);
	});
});
