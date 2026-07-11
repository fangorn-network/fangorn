import { describe, it, expect, beforeAll } from "vitest";
import { CID } from "multiformats/cid";
import { FangornEngine, MetagraphRegistry } from "./index.js";
import { DataRegistryClient } from "../contracts/index.js";

/** Minimal in-memory blockstore matching the get(async-iterable)/put shape the engine uses. */
class MemBlockstore {
    private store = new Map<string, Uint8Array>();
    async put(cid: any, bytes: Uint8Array) { this.store.set(cid.toString(), bytes); }
    async *get(cid: any): AsyncGenerator<Uint8Array> {
        const b = this.store.get(cid.toString());
        if (!b) throw new Error(`not found: ${cid.toString()}`);
        yield b;
    }
}

/** namespaceDiff never touches the chain — it takes root hexes directly — so a stub registry suffices. */
const stubRegistry = {} as unknown as DataRegistryClient;

const NS = "songs";

/** The raw 32-byte root hex a commit CID settles to on-chain (bare sha256 digest). */
const rootHex = (commitCid: CID) => `0x${Buffer.from(commitCid.multihash.digest).toString("hex")}`;

describe("FangornEngine.namespaceDiff", () => {
    let engine: FangornEngine;
    let metagraph: MetagraphRegistry;

    beforeAll(() => {
        metagraph = new MetagraphRegistry();
        metagraph.registerVertex(NS, { id: "track", requiredFields: [] });
        metagraph.registerVertex(NS, { id: "artist", requiredFields: [] });
        metagraph.registerEdge(NS, { sourceSchema: "track", relation: "by", targetSchema: "artist" });
        engine = new FangornEngine(new MemBlockstore() as any, metagraph, stubRegistry);
    });

    /** Seal one commit that stages the given vertices/edges on top of `parent`. */
    async function commit(
        parent: CID | null,
        vertices: { tag: string; payload: any }[],
        edges: { source: string; relation: string; target: string }[] = [],
    ): Promise<CID> {
        const basePail = parent ? (await engine.getCommit(parent)).pailRoot : null;
        const batch = await engine.openBatch(basePail);
        if (!parent) await batch.put(`${NS}/sys/init`, "initialized");
        for (const v of vertices) await engine.stageVertex(batch, NS, v.tag, v.payload);
        for (const e of edges) {
            await engine.stageEdge(batch, NS, { sourceCid: e.source, relation: e.relation, targetCid: e.target }, "track", "artist");
        }
        const { commitCid } = await engine.sealBatch(batch, parent ? [parent] : [], "test");
        return commitCid;
    }

    it("reports added vertices (with payloads) and edges from a genesis root", async () => {
        const c1 = await commit(null, [
            { tag: "track", payload: { title: "Locura" } },
            { tag: "artist", payload: { name: "Alice" } },
        ]);

        const diff = await engine.namespaceDiff(null, rootHex(c1), NS);

        expect(diff.addedVertices).toHaveLength(2);
        expect(diff.addedVertices.map(v => v.payload.title ?? v.payload.name).sort()).toEqual(["Alice", "Locura"]);
        expect(diff.removedVertexCids).toHaveLength(0);
        // The sys/init marker is a literal string, not a CID link, so it never shows up as a change.
        expect(diff.addedVertices.every(v => v.schemaId === "track" || v.schemaId === "artist")).toBe(true);
    });

    it("diffs only the delta between two roots, and recovers edges from the key", async () => {
        const c1 = await commit(null, [{ tag: "artist", payload: { name: "Alice" } }]);
        const [aCid] = (await engine.namespaceDiff(null, rootHex(c1), NS)).addedVertices.map(v => v.cid);

        const c2 = await commit(c1,
            [{ tag: "track", payload: { title: "Otra" } }],
        );
        // stage an edge in a third commit referencing the track + artist CIDs
        const trackCid = (await engine.namespaceDiff(rootHex(c1), rootHex(c2), NS)).addedVertices[0].cid;
        const c3 = await commit(c2, [], [{ source: trackCid, relation: "by", target: aCid }]);

        const step = await engine.namespaceDiff(rootHex(c2), rootHex(c3), NS);
        expect(step.addedVertices).toHaveLength(0); // nothing new staged as a vertex
        expect(step.addedEdges).toEqual([{ sourceCid: trackCid, relation: "by", targetCid: aCid }]);
    });

    it("returns an empty diff when the namespace slice is untouched", async () => {
        const c1 = await commit(null, [{ tag: "track", payload: { title: "Locura" } }]);
        // Diffing a root against itself: no change.
        const diff = await engine.namespaceDiff(rootHex(c1), rootHex(c1), NS);
        expect(diff.addedVertices).toHaveLength(0);
        expect(diff.addedEdges).toHaveLength(0);
        expect(diff.removedVertexCids).toHaveLength(0);
        expect(diff.removedEdges).toHaveLength(0);
    });
});
