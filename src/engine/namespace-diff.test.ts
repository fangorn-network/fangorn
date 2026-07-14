import { describe, it, expect, beforeEach } from "vitest";
import { CID } from "multiformats/cid";
import { FangornEngine, MetagraphRegistry } from "./index.js";
import { MemStorage, StubRegistry, rootHex } from "./test-helpers.js";

const NS = "songs";

describe("FangornEngine.namespaceDiff", () => {
	let engine: FangornEngine;
	let metagraph: MetagraphRegistry;

	beforeEach(() => {
		metagraph = new MetagraphRegistry();
		metagraph.registerVertex(NS, { id: "track", requiredFields: [] });
		metagraph.registerVertex(NS, { id: "artist", requiredFields: [] });
		metagraph.registerEdge(NS, {
			sourceSchema: "track",
			relation: "by",
			targetSchema: "artist",
		});
		engine = new FangornEngine(
			new MemStorage(),
			metagraph,
			new StubRegistry().asClient(),
		);
	});

	/** Create one commit that stages the given vertices/edges on top of `parent`. */
	async function commit(
		parent: CID | null,
		vertices: { id: string; tag: string; payload: Record<string, unknown> }[],
		edges: { relation: string; from: string; to: string }[] = [],
	): Promise<CID> {
		const { commitCid } = await engine.createCommit({
			namespace: NS,
			base: parent,
			vertices: vertices.map((v) => ({
				id: v.id,
				schemaId: v.tag,
				payload: v.payload,
			})),
			edges,
			message: "test",
		});
		return commitCid;
	}

	it("reports added vertices (with payloads) and edges from a genesis root", async () => {
		const c1 = await commit(null, [
			{ id: "t1", tag: "track", payload: { title: "Locura" } },
			{ id: "a1", tag: "artist", payload: { name: "Alice" } },
		]);

		const diff = await engine.namespaceDiff(null, rootHex(c1), NS);

		expect(diff.addedVertices).toHaveLength(2);
		expect(
			diff.addedVertices.map((v) => v.payload.title ?? v.payload.name).sort(),
		).toEqual(["Alice", "Locura"]);
		expect(diff.removedVertexCids).toHaveLength(0);
		expect(
			diff.addedVertices.every(
				(v) => v.schemaId === "track" || v.schemaId === "artist",
			),
		).toBe(true);
	});

	it("diffs only the delta between two roots, and supports edges to earlier-commit vertices by CID", async () => {
		const c1 = await commit(null, [
			{ id: "a1", tag: "artist", payload: { name: "Alice" } },
		]);
		const [aCid] = (
			await engine.namespaceDiff(null, rootHex(c1), NS)
		).addedVertices.map((v) => v.cid);

		const c2 = await commit(c1, [
			{ id: "t1", tag: "track", payload: { title: "Otra" } },
		]);
		const trackCid = (await engine.namespaceDiff(rootHex(c1), rootHex(c2), NS))
			.addedVertices[0].cid;

		// stage an edge in a third commit referencing the track + artist by their CIDs
		const c3 = await commit(
			c2,
			[],
			[{ relation: "by", from: trackCid, to: aCid }],
		);

		const step = await engine.namespaceDiff(rootHex(c2), rootHex(c3), NS);
		expect(step.addedVertices).toHaveLength(0); // nothing new staged as a vertex
		expect(step.addedEdges).toEqual([
			{ sourceCid: trackCid, relation: "by", targetCid: aCid },
		]);
	});

	it("returns an empty diff when the namespace slice is untouched", async () => {
		const c1 = await commit(null, [
			{ id: "t1", tag: "track", payload: { title: "Locura" } },
		]);
		// Diffing a root against itself: no change.
		const diff = await engine.namespaceDiff(rootHex(c1), rootHex(c1), NS);
		expect(diff.addedVertices).toHaveLength(0);
		expect(diff.addedEdges).toHaveLength(0);
		expect(diff.removedVertexCids).toHaveLength(0);
		expect(diff.removedEdges).toHaveLength(0);
	});

	it("a push that only touched ANOTHER namespace yields an empty diff for this one", async () => {
		const c1 = await commit(null, [
			{ id: "t1", tag: "track", payload: { title: "Locura" } },
		]);

		// advance the root via a different namespace
		metagraph.registerVertex("other", { id: "misc", requiredFields: [] });
		const { commitCid: c2 } = await engine.createCommit({
			namespace: "other",
			base: c1,
			vertices: [{ id: "x", schemaId: "misc", payload: { anything: true } }],
			edges: [],
			message: "other ns",
		});

		const diff = await engine.namespaceDiff(rootHex(c1), rootHex(c2), NS);
		expect(diff.addedVertices).toHaveLength(0);
		expect(diff.addedEdges).toHaveLength(0);
		expect(diff.removedVertexCids).toHaveLength(0);
		expect(diff.removedEdges).toHaveLength(0);

		// …while the other namespace sees its own change.
		const otherDiff = await engine.namespaceDiff(
			rootHex(c1),
			rootHex(c2),
			"other",
		);
		expect(otherDiff.addedVertices).toHaveLength(1);
	});
});
