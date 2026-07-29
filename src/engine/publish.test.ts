import { describe, it, expect } from "vitest";
import {
	FangornEngine,
	MetagraphRegistry,
	MAX_NAMESPACE_LENGTH,
} from "./index.js";
import type { Address } from "viem";
import { MemStorage, StubRegistry, rootHex } from "./test-helpers.js";

const PUBLISHER = "0x0000000000000000000000000000000000000001" as Address;

// ── Publish scalability & cost ───────────────────────────────────────────────
//
// The pail-era data layer failed a real publish (quickbeam ingesting a
// Robinhood-chain graph) two ways: pail's per-shared-prefix-character shard
// chains overflowed the call stack at ~13k mixed entries, and each staged entry
// fanned out into ~16 tree blocks, each its own HTTP upload (a 2k-entry ingest
// cycle = ~34k uploads — hours). See git history of publish-overflow.test.ts.
//
// The v2 data layer builds the graph natively in IPLD and persists a commit as
// exactly TWO remote writes: one CAR file (the delta packfile) + one small
// commit block. These tests characterize that contract at the same scale that
// broke pail.

const NS = "rh";
interface V {
	id: string;
	schemaId: string;
	payload: Record<string, unknown>;
}
interface E {
	relation: string;
	from: string;
	to: string;
}

/**
 * Synthetic graph shaped like the real Robinhood publish: A assets, W wallets,
 * T transfers, and 3 edges per transfer (asset→xfer, xfer→wallet ×2). ~5 entries
 * per transfer, so T=3000 ≈ 13k mixed entries — past the legacy pail ceiling.
 */
function robinhoodGraph(T: number): { vertices: V[]; edges: E[] } {
	const A = 96,
		W = 868;
	const vertices: V[] = [];
	for (let i = 0; i < A; i++)
		vertices.push({
			id: `asset:${i.toString()}`,
			schemaId: "Asset",
			payload: { sym: `A${i.toString()}` },
		});
	for (let i = 0; i < W; i++)
		vertices.push({
			id: `wallet:${i.toString()}`,
			schemaId: "Wallet",
			payload: { addr: `0x${i.toString()}` },
		});
	for (let i = 0; i < T; i++)
		vertices.push({
			id: `xfer:${i.toString()}`,
			schemaId: "Transfer",
			payload: { hash: `0xtx${i.toString()}`, v: i },
		});
	const edges: E[] = [];
	for (let i = 0; i < T; i++) {
		edges.push({
			relation: "hasTransfer",
			from: `asset:${(i % A).toString()}`,
			to: `xfer:${i.toString()}`,
		});
		edges.push({
			relation: "sentBy",
			from: `xfer:${i.toString()}`,
			to: `wallet:${(i % W).toString()}`,
		});
		edges.push({
			relation: "receivedBy",
			from: `xfer:${i.toString()}`,
			to: `wallet:${((i + 1) % W).toString()}`,
		});
	}
	return { vertices, edges };
}

function newEngine(storage = new MemStorage(), registry = new StubRegistry()) {
	const mg = new MetagraphRegistry();
	// Permissive schemas for everything the synthetic graph uses. Registered for
	// the second namespace too, so timeline-isolation tests can publish there.
	for (const ns of [NS, "other"])
		for (const tag of ["Asset", "Wallet", "Transfer", "rec"])
			mg.registerVertex(ns, { id: tag, requiredFields: [] });
	for (const [s, rel, t] of [
		["Asset", "hasTransfer", "Transfer"],
		["Transfer", "sentBy", "Wallet"],
		["Transfer", "receivedBy", "Wallet"],
	]) {
		mg.registerEdge(NS, { sourceSchema: s, relation: rel, targetSchema: t });
	}
	return {
		engine: new FangornEngine(storage, mg, registry.asClient()),
		storage,
		registry,
	};
}

describe("publish scalability & cost", () => {
	// The graph size that overflowed pail's batcher now commits in one shot,
	// and every vertex + edge survives the roundtrip.
	it("commits a ~13k-entry graph in a single commit, all data recoverable", async () => {
		const { engine } = newEngine();
		const g = robinhoodGraph(3000);
		const { commitCid } = await engine.createCommit({
			namespace: NS,
			base: null,
			vertices: g.vertices,
			edges: g.edges,
			message: "one",
		});

		const contents = await engine.namespaceDiff(null, rootHex(commitCid), NS);
		expect(contents.addedVertices.length).toBe(g.vertices.length);
		expect(contents.addedEdges.length).toBe(g.edges.length);
		// …and the triples themselves survived (spot-check one).
		const xfer0 = contents.addedVertices.find(
			(v) => v.payload.hash === "0xtx0",
		);
		expect(xfer0).toBeDefined();
		expect(
			contents.addedEdges.some(
				(e) => e.sourceCid === xfer0?.cid && e.relation === "sentBy",
			),
		).toBe(true);
	}, 120_000);

	// THE cost contract: a commit of any size is exactly two remote writes —
	// one CAR (packfile) + one commit block. Pail-era publishes were
	// ~1.4 uploads per staged ENTRY; this is 2 per COMMIT.
	it("persists a commit as exactly 2 remote writes, regardless of graph size", async () => {
		const { engine, storage } = newEngine();
		const g = robinhoodGraph(480); // the observed real ingest cycle size
		await engine.createCommit({
			namespace: NS,
			base: null,
			vertices: g.vertices,
			edges: g.edges,
			message: "cycle",
		});
		expect(storage.writes).toBe(2);
	}, 120_000);

	// Incremental publish (the quickbeam watch-loop shape): each cycle re-stages
	// the accumulated superset plus a small delta. Unchanged blocks re-derive
	// their old CIDs and stay out of the new CAR, and content-defined page
	// boundaries keep the page rewrite local to the insertion points — so a
	// small update costs O(delta pages), not O(namespace). No upload ledger.
	it("a superset re-commit ships only the delta in its CAR", async () => {
		const { engine, storage } = newEngine();
		const g1 = robinhoodGraph(2000);
		const { commitCid: c1 } = await engine.createCommit({
			namespace: NS,
			base: null,
			vertices: g1.vertices,
			edges: g1.edges,
			message: "cycle 1",
		});
		const firstCarSize = [...storage.files.values()][0].length;

		// cycle 2: the same graph re-staged, plus ONE new transfer (1 vertex + 3 edges)
		const g2 = robinhoodGraph(2001);
		await engine.createCommit({
			namespace: NS,
			base: c1,
			vertices: g2.vertices,
			edges: g2.edges,
			message: "cycle 2",
		});
		expect(storage.writes).toBe(4); // still 2 per commit
		const secondCarSize = [...storage.files.values()][1].length;
		expect(secondCarSize).toBeLessThan(firstCarSize / 10);
	}, 120_000);

	// Cold read: a FRESH engine (empty cache — a different process/machine)
	// reconstructs the full namespace from the on-chain head alone, via
	// commit block → CAR chain. This is the clone/subscribe read path.
	it("a cold engine reconstructs the namespace from the on-chain head", async () => {
		const storage = new MemStorage();
		const registry = new StubRegistry();
		const { engine } = newEngine(storage, registry);
		const g = robinhoodGraph(100);
		const { commitCid: c1 } = await engine.createCommit({
			namespace: NS,
			base: null,
			vertices: g.vertices,
			edges: g.edges,
			message: "publish",
		});
		await engine.pushCommit(PUBLISHER, NS, c1);

		// second commit on top, so the read spans a CAR chain
		const g2 = robinhoodGraph(120);
		const { commitCid: c2 } = await engine.createCommit({
			namespace: NS,
			base: c1,
			vertices: g2.vertices,
			edges: g2.edges,
			message: "delta",
		});
		await engine.pushCommit(PUBLISHER, NS, c2);

		const { engine: coldEngine } = newEngine(storage, registry);
		const contents = await coldEngine.listNamespace(NS, PUBLISHER);
		expect(contents.vertices.length).toBe(g2.vertices.length);
		expect(contents.edges.length).toBe(g2.edges.length);
	}, 120_000);

	// Replace mode: the staged graph IS the new namespace state — omitted
	// entries are removed (and show up as removals in the diff), while
	// re-staged unchanged blocks are neither re-uploaded nor reported.
	it("a replace commit removes omitted entries and ships no redundant blocks", async () => {
		const { engine, storage } = newEngine();
		const g = robinhoodGraph(100);
		const { commitCid: c1 } = await engine.createCommit({
			namespace: NS,
			base: null,
			vertices: g.vertices,
			edges: g.edges,
			message: "full",
		});

		// keep everything except transfer 0 (and its 3 edges)
		const kept = {
			vertices: g.vertices.filter((v) => v.id !== "xfer:0"),
			edges: g.edges.filter((e) => e.from !== "xfer:0" && e.to !== "xfer:0"),
		};
		const writesBefore = storage.writes;
		const { commitCid: c2 } = await engine.createCommit({
			namespace: NS,
			base: c1,
			vertices: kept.vertices,
			edges: kept.edges,
			message: "prune",
			replace: true,
		});
		expect(storage.writes - writesBefore).toBe(2);

		const diff = await engine.namespaceDiff(rootHex(c1), rootHex(c2), NS);
		expect(diff.addedVertices).toHaveLength(0);
		expect(diff.addedEdges).toHaveLength(0);
		expect(diff.removedVertexCids).toHaveLength(1);
		expect(diff.removedEdges).toHaveLength(3);
		expect(
			diff.removedEdges.every(
				(e) =>
					e.relation === "hasTransfer" ||
					e.relation === "sentBy" ||
					e.relation === "receivedBy",
			),
		).toBe(true);
	});

	// Each namespace is its own on-chain timeline, which is the whole point of the
	// hierarchical registry: two namespaces advance independently, and pushing one
	// never invalidates the other's compare-and-swap. Under the old flat model
	// both shared a single publisher head, so the second push here would have had
	// to build on the first.
	it("keeps each namespace's on-chain timeline independent", async () => {
		const { engine, registry } = newEngine();
		const mkCommit = (namespace: string, base: null, i: number) =>
			engine.createCommit({
				namespace,
				base,
				vertices: [{ id: "0", schemaId: "rec", payload: { i } }],
				edges: [],
				message: `commit ${i.toString()}`,
			});

		// Both are root commits (base: null) — neither knows about the other.
		const { commitCid: a } = await mkCommit(NS, null, 1);
		const { commitCid: b } = await mkCommit("other", null, 2);

		await engine.pushCommit(PUBLISHER, NS, a);
		await engine.pushCommit(PUBLISHER, "other", b);

		expect(await registry.getNamespaceHead(PUBLISHER, NS)).toBe(rootHex(a));
		expect(await registry.getNamespaceHead(PUBLISHER, "other")).toBe(
			rootHex(b),
		);
		// An untouched namespace stays at zero rather than inheriting a head.
		expect(await registry.getNamespaceHead(PUBLISHER, "unused")).toBe(
			`0x${"0".repeat(64)}`,
		);
	});

	// Namespace name bounds: garbage input is rejected up front with a clear error.
	it("rejects an over-long namespace with a clear error", async () => {
		const { engine } = newEngine();
		const ns = "n".repeat(4000);
		await expect(
			engine.createCommit({
				namespace: ns,
				base: null,
				vertices: [],
				edges: [],
				message: "x",
			}),
		).rejects.toThrow(/maximum length/i);
	});

	// Sanity: a max-length namespace still publishes fine.
	it("publishes into a max-length namespace", async () => {
		const { storage } = newEngine();
		const ns = "n".repeat(MAX_NAMESPACE_LENGTH);
		const mg = new MetagraphRegistry();
		mg.registerVertex(ns, { id: "rec", requiredFields: [] });
		const e2 = new FangornEngine(storage, mg, new StubRegistry().asClient());
		const { commitCid } = await e2.createCommit({
			namespace: ns,
			base: null,
			vertices: [
				{ id: "0", schemaId: "rec", payload: { i: 0 } },
				{ id: "1", schemaId: "rec", payload: { i: 1 } },
			],
			edges: [],
			message: "x",
		});
		const diff = await e2.namespaceDiff(null, rootHex(commitCid), ns);
		expect(diff.addedVertices).toHaveLength(2);
	});
});
