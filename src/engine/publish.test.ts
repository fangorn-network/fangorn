import { describe, it, expect } from "vitest";
import {
	FangornEngine,
	MAX_REPO_NAME_LENGTH,
	type RecordInput,
} from "./index.js";
import { MemStorage, PUBLISHER, newRegistry, rootHex } from "./test-helpers.js";


// ── Publish scalability & cost ───────────────────────────────────────────────
//
// The pail-era data layer failed a real publish (quickbeam ingesting a
// Robinhood-chain graph) two ways: pail's per-shared-prefix-character shard
// chains overflowed the call stack at ~13k mixed entries, and each staged entry
// fanned out into ~16 tree blocks, each its own HTTP upload (a 2k-entry ingest
// cycle = ~34k uploads — hours). See git history of publish-overflow.test.ts.
//
// The record layer builds a Merkle Search Tree natively in IPLD and persists a
// commit as exactly TWO remote writes: one CAR file (the delta packfile) + one small
// commit block. These tests characterize that contract at the same scale that
// broke pail.

const NS = "rh";

/**
 * Synthetic data shaped like the real Robinhood publish: A assets, W wallets,
 * T transfers, and 3 relation records per transfer (asset→xfer, xfer→wallet ×2).
 * ~5 records per transfer, so T=3000 ≈ 13k records — past the legacy pail ceiling.
 */
function robinhoodRecords(T: number): RecordInput[] {
	const A = 96,
		W = 868;
	const records: RecordInput[] = [];
	for (let i = 0; i < A; i++)
		records.push({ id: `asset:${i.toString()}`, type: "Asset", payload: { sym: `A${i.toString()}` } });
	for (let i = 0; i < W; i++)
		records.push({ id: `wallet:${i.toString()}`, type: "Wallet", payload: { addr: `0x${i.toString()}` } });
	const rel = (type: string, src: string, dst: string): RecordInput => ({
		id: `${src}>${type}>${dst}`,
		type,
		payload: { src: { local: src }, dst: { local: dst } },
	});
	for (let i = 0; i < T; i++) {
		const x = `xfer:${i.toString()}`;
		records.push({ id: x, type: "Transfer", payload: { hash: `0xtx${i.toString()}`, v: i } });
		records.push(rel("hasTransfer", `asset:${(i % A).toString()}`, x));
		records.push(rel("sentBy", x, `wallet:${(i % W).toString()}`));
		records.push(rel("receivedBy", x, `wallet:${((i + 1) % W).toString()}`));
	}
	return records;
}

function newEngine(storage = new MemStorage(), registry = newRegistry()) {
	return {
		engine: new FangornEngine(storage, registry),
		storage,
		registry,
	};
}

describe("publish scalability & cost", () => {
	// The size that overflowed pail's batcher now commits in one shot, and
	// every record survives the roundtrip.
	it("commits ~13k records in a single commit, all data recoverable", async () => {
		const { engine } = newEngine();
		const records = robinhoodRecords(3000);
		const { commitCid } = await engine.createCommit({
			repo: NS,
			base: null,
			records,
			message: "one",
		});

		const contents = await engine.repoDiff(null, rootHex(commitCid));
		expect(contents.puts.length).toBe(records.length);
		// …and a relation record survived with its references (spot-check one).
		expect(
			contents.puts.find((r) => r.id === "xfer:0>sentBy>wallet:0")?.payload,
		).toEqual({ src: { local: "xfer:0" }, dst: { local: "wallet:0" } });
	}, 120_000);

	// THE cost contract: a commit of any size is exactly two remote writes —
	// one CAR (packfile) + one commit block. Pail-era publishes were
	// ~1.4 uploads per staged ENTRY; this is 2 per COMMIT.
	it("persists a commit as exactly 2 remote writes, regardless of size", async () => {
		const { engine, storage } = newEngine();
		await engine.createCommit({
			repo: NS,
			base: null,
			records: robinhoodRecords(480), // the observed real ingest cycle size
			message: "cycle",
		});
		expect(storage.writes).toBe(2);
	}, 120_000);

	// Incremental publish (the quickbeam watch-loop shape): each cycle re-stages
	// the accumulated superset plus a small delta. Unchanged blocks re-derive
	// their old CIDs and stay out of the new CAR, and MST nodes off the changed
	// paths keep their CIDs — so a small update costs O(delta · depth), not
	// O(repo). No upload ledger.
	it("a superset re-commit ships only the delta in its CAR", async () => {
		const { engine, storage } = newEngine();
		const { commitCid: c1 } = await engine.createCommit({
			repo: NS,
			base: null,
			records: robinhoodRecords(2000),
			message: "cycle 1",
		});
		const firstCarSize = [...storage.files.values()][0].length;

		// cycle 2: the same records re-staged, plus ONE new transfer (4 records)
		await engine.createCommit({
			repo: NS,
			base: c1,
			records: robinhoodRecords(2001),
			message: "cycle 2",
		});
		expect(storage.writes).toBe(4); // still 2 per commit
		const secondCarSize = [...storage.files.values()][1].length;
		expect(secondCarSize).toBeLessThan(firstCarSize / 10);
	}, 120_000);

	// Cold read: a FRESH engine (empty cache — a different process/machine)
	// reconstructs the full repo from the on-chain head alone, via
	// commit block → CAR chain. This is the clone/subscribe read path.
	it("a cold engine reconstructs the repo from the on-chain head", async () => {
		const storage = new MemStorage();
		const registry = newRegistry();
		const { engine } = newEngine(storage, registry);
		const { commitCid: c1 } = await engine.createCommit({
			repo: NS,
			base: null,
			records: robinhoodRecords(100),
			message: "publish",
		});
		await engine.pushCommit(PUBLISHER, NS, c1);

		// second commit on top, so the read spans a CAR chain
		const r2 = robinhoodRecords(120);
		const { commitCid: c2 } = await engine.createCommit({
			repo: NS,
			base: c1,
			records: r2,
			message: "delta",
		});
		await engine.pushCommit(PUBLISHER, NS, c2);

		const { engine: coldEngine } = newEngine(storage, registry);
		const contents = await coldEngine.listRepo(PUBLISHER, NS);
		expect(contents.records.length).toBe(r2.length);
	}, 120_000);

	// Replace mode: the staged records ARE the new repo state — omitted
	// records are removed (and show up as deletes in the diff), while re-staged
	// unchanged blocks are neither re-uploaded nor reported.
	it("a replace commit removes omitted records and ships no redundant blocks", async () => {
		const { engine, storage } = newEngine();
		const records = robinhoodRecords(100);
		const { commitCid: c1 } = await engine.createCommit({
			repo: NS,
			base: null,
			records,
			message: "full",
		});

		// keep everything except transfer 0 and its 3 relation records
		const kept = records.filter((r) => !r.id?.includes("xfer:0>") && !r.id?.endsWith(">xfer:0") && r.id !== "xfer:0");
		const writesBefore = storage.writes;
		const { commitCid: c2 } = await engine.createCommit({
			repo: NS,
			base: c1,
			records: kept,
			message: "prune",
			replace: true,
		});
		expect(storage.writes - writesBefore).toBe(2);

		const diff = await engine.repoDiff(rootHex(c1), rootHex(c2));
		expect(diff.puts).toHaveLength(0);
		expect(diff.deletes.sort()).toEqual([
			"asset:0>hasTransfer>xfer:0",
			"xfer:0",
			"xfer:0>receivedBy>wallet:1",
			"xfer:0>sentBy>wallet:0",
		]);
	});

	// Each repo is its own on-chain timeline, which is the whole point of the
	// hierarchical registry: two repos advance independently, and pushing one
	// never invalidates the other's compare-and-swap. Under the old flat model
	// both shared a single publisher head, so the second push here would have had
	// to build on the first.
	it("keeps each repo's on-chain timeline independent", async () => {
		const { engine, registry } = newEngine();
		const mkCommit = (repo: string, base: null, i: number) =>
			engine.createCommit({
				repo,
				base,
				records: [{ id: "0", type: "rec", payload: { i } }],
				message: `commit ${i.toString()}`,
			});

		// Both are root commits (base: null) — neither knows about the other.
		const { commitCid: a } = await mkCommit(NS, null, 1);
		const { commitCid: b } = await mkCommit("other", null, 2);

		await engine.pushCommit(PUBLISHER, NS, a);
		await engine.pushCommit(PUBLISHER, "other", b);

		expect(await registry.head({ publisher: PUBLISHER, repo: NS })).toBe(rootHex(a));
		expect(await registry.head({ publisher: PUBLISHER, repo: "other" })).toBe(
			rootHex(b),
		);
		// An untouched repo stays at zero rather than inheriting a head.
		expect(await registry.head({ publisher: PUBLISHER, repo: "unused" })).toBe(
			`0x${"0".repeat(64)}`,
		);
	});

	// Repo name bounds: garbage input is rejected up front with a clear error.
	it("rejects an over-long repo with a clear error", async () => {
		const { engine } = newEngine();
		const ns = "n".repeat(4000);
		await expect(
			engine.createCommit({
				repo: ns,
				base: null,
				records: [],
				message: "x",
			}),
		).rejects.toThrow(/maximum length/i);
	});

	// Sanity: a max-length repo still publishes fine.
	it("publishes into a max-length repo", async () => {
		const { storage } = newEngine();
		const ns = "n".repeat(MAX_REPO_NAME_LENGTH);
		const e2 = new FangornEngine(storage, newRegistry());
		const { commitCid } = await e2.createCommit({
			repo: ns,
			base: null,
			records: [
				{ id: "0", type: "rec", payload: { i: 0 } },
				{ id: "1", type: "rec", payload: { i: 1 } },
			],
			message: "x",
		});
		const diff = await e2.repoDiff(null, rootHex(commitCid));
		expect(diff.puts).toHaveLength(2);
	});
});
