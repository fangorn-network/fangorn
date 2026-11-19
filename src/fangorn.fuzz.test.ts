/* eslint-disable vitest/no-conditional-expect -- model-based: the model decides what each step expects */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hash } from "viem";
import { MemRegistry, memoryNetwork } from "./test/testbed.js";
import { take } from "./test/sdk-suite.js";
import type { Fangorn, RepoChange } from "./fangorn.js";
import type { CommitUpdate } from "./contracts/index.js";
import { EPOCH_SECONDS, WINDOW } from "./contracts/index.js";
import { CommitFeed } from "./feed.js";
import { commitUpdate } from "./engine/index.js";
import { CID } from "multiformats/cid";

// Model-based fuzz of the push/subscribe lifecycle on the in-memory registry:
// 1-3 writers (some sharing a key, so contending for one repo's head) build
// commits on whatever head they last saw, push, race, re-push stale commits and
// hit ambiguous write failures, while subscribers poll at random points.
// Invariants: a push lands iff its parent is the head; heads advance by one
// position at a time; every subscriber sees every landed commit exactly once,
// in order, and its reconstructed state equals the repo's final state.

const RUNS = Number(process.env.FUZZ_RUNS ?? 50);
const SEED = 0xfa1;
const REPO = "r";
const IDS = ["a", "b", "c", "d"] as const;

/** A registry whose next write fails before or after it lands (an RPC timeout after send). */
class FlakyRegistry extends MemRegistry {
	failNext: "before" | "after" | null = null;
	async update(u: CommitUpdate): Promise<Hash> {
		const mode = this.failNext;
		this.failNext = null;
		if (mode === "before") throw new Error("socket hang up");
		const hash = await super.update(u);
		if (mode === "after") throw new Error("tx was not confirmed in time");
		return hash;
	}
}

type Op =
	| { t: "commit"; w: number; puts: string[]; dels: string[] }
	| { t: "push"; w: number; k: number; fail: "before" | "after" | null }
	| { t: "race"; a: number; b: number }
	| { t: "fetch"; w: number }
	| { t: "poll"; s: number }
	| { t: "lateSub" };

const w = fc.nat({ max: 2 });
const op: fc.Arbitrary<Op> = fc.oneof(
	{
		weight: 4,
		arbitrary: fc.record({
			t: fc.constant("commit" as const),
			w,
			puts: fc.uniqueArray(fc.constantFrom(...IDS), {
				minLength: 1,
				maxLength: 3,
			}),
			dels: fc.uniqueArray(fc.constantFrom(...IDS), { maxLength: 2 }),
		}),
	},
	{
		weight: 4,
		arbitrary: fc.record({
			t: fc.constant("push" as const),
			w,
			// mostly the writer's newest commit; sometimes an older (stale) one
			k: fc.oneof(
				{ weight: 3, arbitrary: fc.constant(-1) },
				{ weight: 1, arbitrary: fc.nat({ max: 7 }) },
			),
			fail: fc.oneof(
				{ weight: 6, arbitrary: fc.constant(null) },
				{ weight: 1, arbitrary: fc.constant("before" as const) },
				{ weight: 1, arbitrary: fc.constant("after" as const) },
			),
		}),
	},
	{
		weight: 1,
		arbitrary: fc.record({ t: fc.constant("race" as const), a: w, b: w }),
	},
	{ weight: 2, arbitrary: fc.record({ t: fc.constant("fetch" as const), w }) },
	{
		weight: 2,
		arbitrary: fc.record({
			t: fc.constant("poll" as const),
			s: fc.nat({ max: 1 }),
		}),
	},
	{ weight: 1, arbitrary: fc.constant({ t: "lateSub" as const }) },
);

type State = Map<string, number>;

/** A subscriber driven by hand: `drain` pulls exactly the changes known to be pending. */
function subscriber(f: Fangorn) {
	const ac = new AbortController();
	const it = f.subscribeAll({ repo: REPO, fromBlock: 0n, signal: ac.signal });
	const got: RepoChange[] = [];
	return {
		got,
		async drain(n: number) {
			while (got.length < n) {
				const next = await Promise.race([
					it.next(),
					new Promise<never>((_, rej) =>
						setTimeout(() => {
							rej(
								new Error(
									`subscriber stalled at ${String(got.length)}/${String(n)}`,
								),
							);
						}, 2_000),
					),
				]);
				if (next.done) throw new Error("subscription ended");
				got.push(next.value);
			}
		},
		stop: () => {
			ac.abort();
			void it.return(undefined);
		},
	};
}

function replay(changes: RepoChange[]): Map<string, State> {
	const out = new Map<string, State>();
	for (const c of changes) {
		const key = c.owner.toLowerCase();
		const s = out.get(key) ?? new Map<string, number>();
		for (const id of c.deletes) s.delete(id);
		for (const r of c.puts) s.set(r.id, r.payload.v as number);
		out.set(key, s);
	}
	return out;
}

describe("push/subscribe lifecycle (model-based, in memory)", () => {
	it("subscribers reconstruct exactly the landed history", async () => {
		await fc.assert(
			fc.asyncProperty(
				// which key each of the 3 writers holds: equal keys contend for one head
				fc.tuple(fc.nat({ max: 1 }), fc.nat({ max: 1 }), fc.nat({ max: 1 })),
				fc.array(op, { minLength: 15, maxLength: 50 }),
				async (keyOf, ops) => {
					const net = memoryNetwork();
					const sks = [generatePrivateKey(), generatePrivateKey()];
					const regs: FlakyRegistry[] = [];
					const writers = await Promise.all(
						keyOf.map(async (k) => {
							const f = await net.client(
								sks[k],
								class extends FlakyRegistry {
									constructor(...a: ConstructorParameters<typeof MemRegistry>) {
										super(...a);
										regs.push(this);
									}
								},
							);
							return f;
						}),
					);
					const pub = (i: number) => writers[i].getAddress().toLowerCase();

					// model
					const head = new Map<string, string | null>();
					const pos = new Map<string, number>();
					const landed = new Map<string, string[]>(); // publisher -> commit cids in order
					const stateOf = new Map<string | null, State>([[null, new Map()]]);
					const parentOf = new Map<string, string | null>();
					const known: (string | null)[] = [null, null, null];
					const prepared: string[][] = [[], [], []];
					let total = 0;
					let counter = 0;

					const subs = [subscriber(await net.client())];
					const land = (p: string, cid: string) => {
						const before = pos.get(p) ?? 0;
						expect(parentOf.get(cid) ?? null).toBe(head.get(p) ?? null);
						head.set(p, cid);
						pos.set(p, before + 1);
						landed.set(p, [...(landed.get(p) ?? []), cid]);
						total++;
					};
					const checkChain = async (i: number) => {
						const p = pub(i);
						const reg = writers[i].getRegistry();
						const at = await reg.headAt({
							publisher: writers[i].getAddress(),
							repo: REPO,
						});
						expect(at.pos).toBe(pos.get(p) ?? 0);
						expect(
							await writers[i].onChainTip(writers[i].getAddress(), REPO),
						).toBe(head.get(p) ?? null);
					};

					try {
						for (const o of ops) {
							switch (o.t) {
								case "commit": {
									const base = known[o.w];
									const puts = o.puts.map((id) => ({
										id,
										type: "t",
										payload: { v: ++counter },
									}));
									const dels = o.dels.filter((d) => !o.puts.includes(d));
									const { commitCid } = await writers[o.w].commit({
										repo: REPO,
										parent: base ?? undefined,
										records: puts,
										deletes: dels,
									});
									const s = new Map(stateOf.get(base));
									for (const d of dels) s.delete(d);
									for (const r of puts) s.set(r.id, r.payload.v);
									stateOf.set(commitCid, s);
									parentOf.set(commitCid, base);
									prepared[o.w].push(commitCid);
									break;
								}
								case "push": {
									const list = prepared[o.w];
									if (!list.length) break;
									const cid =
										list[o.k < 0 ? list.length - 1 : o.k % list.length];
									const p = pub(o.w);
									const shouldLand =
										(parentOf.get(cid) ?? null) === (head.get(p) ?? null);
									regs[o.w].failNext = shouldLand ? o.fail : null;
									const ok = await writers[o.w].push(REPO, cid).then(
										() => true,
										(e: unknown) => {
											if (!shouldLand)
												expect((e as Error).message).toMatch(
													/stale|StaleStateRoot/,
												);
											return false;
										},
									);
									// Lands iff its parent is the head — even when the call
									// itself failed after the registry took it.
									expect(ok).toBe(shouldLand && o.fail === null);
									if (shouldLand && o.fail !== "before") {
										land(p, cid);
										known[o.w] = cid;
									}
									await checkChain(o.w);
									break;
								}
								case "race": {
									const a = prepared[o.a].at(-1);
									const b = prepared[o.b].at(-1);
									if (!a || !b) break;
									const before = new Map(head);
									const res = await Promise.allSettled([
										writers[o.a].push(REPO, a),
										writers[o.b].push(REPO, b),
									]);
									const pa = pub(o.a);
									const pb = pub(o.b);
									const okA = res[0].status === "fulfilled";
									const okB = res[1].status === "fulfilled";
									if (pa === pb) {
										// one head, one compare-and-swap: never both
										expect(okA && okB).toBe(false);
										const canA =
											(parentOf.get(a) ?? null) === (before.get(pa) ?? null);
										const canB =
											(parentOf.get(b) ?? null) === (before.get(pb) ?? null);
										expect(okA || okB).toBe(canA || canB);
									} else {
										expect(okA).toBe(
											(parentOf.get(a) ?? null) === (before.get(pa) ?? null),
										);
										expect(okB).toBe(
											(parentOf.get(b) ?? null) === (before.get(pb) ?? null),
										);
									}
									if (okA) {
										land(pa, a);
										known[o.a] = a;
									}
									if (okB) {
										land(pb, b);
										known[o.b] = b;
									}
									await checkChain(o.a);
									await checkChain(o.b);
									break;
								}
								case "fetch":
									known[o.w] = await writers[o.w].onChainTip(
										writers[o.w].getAddress(),
										REPO,
									);
									break;
								case "poll":
									if (subs[o.s]) await subs[o.s].drain(total);
									break;
								case "lateSub":
									if (subs.length < 2)
										subs.push(subscriber(await net.client()));
									break;
							}
						}

						// Every subscriber, drained: exactly the landed commits, in order, once.
						for (const s of subs) {
							await s.drain(total);
							const cids = s.got.map((c) => c.commitCid);
							expect(new Set(cids).size).toBe(cids.length);
							for (const [p, chain] of landed)
								expect(
									s.got
										.filter((c) => c.owner.toLowerCase() === p)
										.map((c) => c.commitCid),
								).toEqual(chain);
							const replayed = replay(s.got);
							for (const [p, cid] of head)
								expect(Object.fromEntries(replayed.get(p) ?? [])).toEqual(
									Object.fromEntries(stateOf.get(cid) ?? []),
								);
						}
						// And the repo as read equals the model.
						for (let i = 0; i < writers.length; i++) {
							const { contents } = await writers[i].readRepo(
								writers[i].getAddress(),
								REPO,
							);
							const read = Object.fromEntries(
								contents.records.map((r) => [r.id, r.payload.v]),
							);
							expect(read).toEqual(
								Object.fromEntries(stateOf.get(head.get(pub(i)) ?? null) ?? []),
							);
						}
					} finally {
						for (const s of subs) s.stop();
					}
				},
			),
			{ seed: SEED, numRuns: RUNS },
		);
	}, 120_000);
});

describe("ambiguous push failures", () => {
	// A tx that landed but whose receipt timed out. The retry should see its own
	// commit at the head and report success; today it reports a stale parent.
	it.fails(
		"a retried push of a commit that already landed reports success",
		async () => {
			const net = memoryNetwork();
			const sk = generatePrivateKey();
			const regs: FlakyRegistry[] = [];
			const f = await net.client(
				sk,
				class extends FlakyRegistry {
					constructor(...a: ConstructorParameters<typeof MemRegistry>) {
						super(...a);
						regs.push(this);
					}
				},
			);
			const [reg] = regs;
			const { commitCid } = await f.commit({
				repo: REPO,
				records: [{ id: "a", type: "t", payload: {} }],
			});
			reg.failNext = "after";
			await expect(f.push(REPO, commitCid)).rejects.toThrow();
			expect(await f.onChainTip(f.getAddress(), REPO)).toBe(commitCid); // it did land
			await f.push(REPO, commitCid); // throws "stale parent"
		},
	);
});

describe("epoch window", () => {
	/** A network whose clock is set by hand. */
	async function clocked(start: number) {
		const net = memoryNetwork();
		const clock = { now: start };
		const sk = generatePrivateKey();
		const f = await net.client(
			sk,
			class extends MemRegistry {
				constructor(...a: ConstructorParameters<typeof MemRegistry>) {
					super(a[0], a[1], () => clock.now, privateKeyToAccount(sk));
				}
			},
		);
		return { f, clock };
	}

	it("a commit lands iff the registry's epoch is within [e, e + WINDOW] of the commit's", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 1_700_000_000, max: 1_800_000_000 }),
				// seconds of delay between building and pushing, around the window's edges
				fc.oneof(
					fc.integer({ min: 0, max: (WINDOW + 2) * EPOCH_SECONDS }),
					fc.integer({
						min: WINDOW * EPOCH_SECONDS - 2,
						max: (WINDOW + 1) * EPOCH_SECONDS + 2,
					}),
				),
				fc.boolean(),
				async (t0, delay, relayed) => {
					const { f, clock } = await clocked(t0);
					const { commitCid } = await f.commit({
						repo: REPO,
						records: [{ id: "a", type: "t", payload: {} }],
					});
					const e = Math.floor(t0 / EPOCH_SECONDS);
					const signed = relayed ? await f.signPush(REPO, commitCid) : null;
					clock.now = t0 + delay;
					const now = Math.floor(clock.now / EPOCH_SECONDS);
					const ok = await (
						signed ? f.relayPush(signed) : f.push(REPO, commitCid)
					).then(
						() => true,
						(err: unknown) => {
							expect((err as Error).message).toMatch(/EpochOutOfWindow/);
							return false;
						},
					);
					expect(ok).toBe(now <= e + WINDOW);
				},
			),
			{ seed: SEED, numRuns: RUNS * 4 },
		);
	});

	it("a commit's epoch is the registry's clock, not the local machine's", async () => {
		// the registry's clock 3 days behind the machine's
		const { f } = await clocked(Math.floor(Date.now() / 1000) - 3 * 86_400);
		const { commitCid } = await f.commit({
			repo: REPO,
			records: [{ id: "a", type: "t", payload: {} }],
		});
		await expect(f.push(REPO, commitCid)).resolves.toBeDefined();
	});
});

describe("subscription faults", () => {
	// Any publisher can land a head whose commit block was never uploaded (the
	// contract hashes whatever digests it is given). subscribeAll used to throw on
	// it, ending the stream for every other repo too; now it skips and reports it.
	it("one unresolvable third-party head does not end subscribeAll for others", async () => {
		const net = memoryNetwork();
		const good = await net.client();
		const attacker = await net.client();
		const reader = await net.client();
		const skipped: string[] = [];
		const stream = reader.subscribeAll({
			fromBlock: 0n,
			onSkip: (_, e) => skipped.push(e.repo),
		});

		const { commitCid } = await attacker.commit({
			repo: "junk",
			records: [{ id: "x", type: "t", payload: {} }],
		});
		// The same update with a diff digest nothing was stored under: a head with no block.
		const u = commitUpdate(
			await attacker.engine.getCommit(CID.parse(commitCid)),
		);
		await attacker.getRegistry().update({ ...u, diff: `0x${"ab".repeat(32)}` });

		await good.initRepo("docs");
		await good.upload("docs", { n: 1 }, "t", "a");
		await good.upload("docs", { n: 2 }, "t", "b");
		const changes = await take(stream, 2);
		expect(changes.map((c) => c.puts.map((r) => r.id))).toEqual([["a"], ["b"]]);
		expect(skipped).toEqual(["junk"]);
	});

	// CommitFeed used to restart a failed watch live, from the tip, never delivering
	// commits landed while it was down; it now resumes from its cursor.
	it("CommitFeed delivers the commits that land while it restarts", async () => {
		const net = memoryNetwork();
		const pub = await net.client();
		await pub.initRepo("docs");
		let opens = 0;
		const reader = await net.client();
		const feed = new CommitFeed((signal, fromBlock) => {
			opens++;
			const gen = reader.subscribeAll({ signal, fromBlock });
			if (opens > 1) return gen;
			// The first watch dies after one change.
			return (async function* () {
				for await (const c of gen) {
					yield c;
					throw new Error("RPC hiccup");
				}
			})();
		}, 50);
		const got: string[] = [];
		const off = feed.on(
			(c) => got.push(...c.puts.map((r) => r.id)),
			() => undefined,
		);
		await new Promise((r) => setTimeout(r, 10));
		await pub.upload("docs", { n: 1 }, "t", "a"); // delivered, then the watch fails
		await pub.upload("docs", { n: 2 }, "t", "b"); // lands during the restart delay
		await new Promise((r) => setTimeout(r, 150));
		await pub.upload("docs", { n: 3 }, "t", "c");
		await new Promise((r) => setTimeout(r, 50));
		off();
		expect(got).toEqual(["a", "b", "c"]);
	});
});
