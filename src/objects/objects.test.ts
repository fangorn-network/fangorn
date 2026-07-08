import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { type Address, type Hex } from "viem";
import { canonicalize } from "./canonical.js";
import { ObjectStore, blobCids, diffManifests } from "./store.js";
import { isCommit } from "./types.js";
import { serialize, deserialize } from "../providers/storage/utils.js";
import type { MetadataStorage } from "../providers/storage/types.js";
import type { Manifest, BundleManifest } from "../roles/publisher/types.js";

// In-memory content-addressed store: the CID is a hash of the exact bytes, so it
// exercises the same determinism/structural-sharing guarantees IPFS gives us.
class MemStore implements MetadataStorage {
    readonly blocks = new Map<string, string>();
    put(data: unknown): Promise<string> {
        const content = serialize(data);
        const cid = "bafy" + createHash("sha256").update(content).digest("hex").slice(0, 32);
        this.blocks.set(cid, content);
        return Promise.resolve(cid);
    }
    putMany(items: { data: unknown; name: string }[]): Promise<Record<string, string>> {
        const out: Record<string, string> = {};
        for (const it of items) {
            const content = serialize(it.data);
            const cid = "bafy" + createHash("sha256").update(content).digest("hex").slice(0, 32);
            this.blocks.set(cid, content);
            out[it.name] = cid;
        }
        return Promise.resolve(out);
    }
    get<T>(uri: string): Promise<T> {
        const content = this.blocks.get(uri);
        if (content === undefined) throw new Error(`not found: ${uri}`);
        return Promise.resolve(deserialize(content) as T);
    }
    delete(uri: string): Promise<void> {
        this.blocks.delete(uri);
        return Promise.resolve();
    }
}

const AUTHOR = "0x1111111111111111111111111111111111111111" as Address;
const SCHEMA = ("0x" + "22".repeat(32)) as Hex;
const ROOT = ("0x" + "33".repeat(32)) as Hex;

function recordSetManifest(dataCids: string[]): Manifest {
    return {
        kind: "record-set",
        schemaId: SCHEMA,
        root: ROOT,
        entries: dataCids.map((cid, i) => ({
            name: `chunk:${i.toString()}`,
            fields: { dataCid: cid, leaf: ("0x" + "00".repeat(32)) as Hex },
        })),
        tree: [],
    };
}

describe("canonicalize", () => {
    it("is independent of key insertion order", () => {
        const a = canonicalize({ b: 1, a: 2, c: [3, { y: 1, x: 2 }] });
        const b = canonicalize({ c: [3, { x: 2, y: 1 }], a: 2, b: 1 });
        expect(a).toBe(b);
    });

    it("drops undefined-valued keys so optional fields don't perturb the hash", () => {
        expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
    });

    it("round-trips through the storage deserializer", () => {
        const obj = { kind: "commit", parents: ["x"], n: 5 };
        expect(deserialize(canonicalize(obj))).toEqual(obj);
    });

    it("rejects bigint (must be stringified first)", () => {
        expect(() => canonicalize({ n: 1n })).toThrow(/bigint/);
    });

    // S0 golden fixture: the shared byte string quickbeam's Python canonicalizer
    // must also reproduce (embeddings/quickbeam/test_objects.py). If this changes,
    // regenerate the golden per docs/objects/README.md and update both repos.
    it("reproduces the S0 golden fixture byte-for-byte", () => {
        const dir = join(dirname(fileURLToPath(import.meta.url)), "../../docs/objects");
        const commit: unknown = JSON.parse(readFileSync(join(dir, "commit.fixture.json"), "utf8"));
        const expected = readFileSync(join(dir, "commit.canonical.txt"), "utf8");
        expect(canonicalize(commit)).toBe(expected);
    });
});

describe("blobCids", () => {
    it("extracts dataCids from a record-set", () => {
        expect(blobCids(recordSetManifest(["a", "b"]))).toEqual(["a", "b"]);
    });

    it("extracts node + edge chunks from a bundle", () => {
        const m: BundleManifest = {
            kind: "bundle",
            schemaId: SCHEMA,
            root: ROOT,
            nodeChunks: [{ type: "Place", dataCid: "n1", leaf: ROOT }],
            edgeChunks: [{ dataCid: "e1", leaf: ROOT }],
            tree: [],
        };
        expect(blobCids(m).sort()).toEqual(["e1", "n1"]);
    });
});

describe("diffManifests", () => {
    it("reports everything as added when there is no parent", () => {
        const d = diffManifests(undefined, recordSetManifest(["a", "b"]));
        expect(d.added.sort()).toEqual(["a", "b"]);
        expect(d.removed).toEqual([]);
    });

    it("detects added and removed blobs while ignoring unchanged (shared) ones", () => {
        const parent = recordSetManifest(["places", "hours-v1"]);
        const child = recordSetManifest(["places", "hours-v2"]);
        const d = diffManifests(parent, child);
        expect(d.added).toEqual(["hours-v2"]); // new page
        expect(d.removed).toEqual(["hours-v1"]); // superseded page
        // "places" is shared → in neither list
    });
});

describe("structural sharing (contentId)", () => {
    // A chunk reused across commits gets a NEW retrieval uri (different CAR root +
    // entry index) but the SAME contentId. Diffing must key on contentId so the
    // unchanged chunk reads as shared, not added+removed.
    const leaf = ("0x" + "00".repeat(32)) as Hex;
    const withRefs = (rows: { dataCid: string; contentId: string }[]): Manifest => ({
        kind: "record-set", schemaId: SCHEMA, root: ROOT, tree: [],
        entries: rows.map((r, i) => ({ name: `c${i.toString()}`, fields: { dataCid: r.dataCid, contentId: r.contentId, leaf } })),
    });

    it("treats a reused chunk under a new uri as shared", () => {
        const parent = withRefs([
            { dataCid: "ipfs://ROOT1/chunk:1", contentId: "hash-b" },
            { dataCid: "ipfs://ROOT1/chunk:0", contentId: "hash-a" },
        ]);
        const child = withRefs([
            { dataCid: "ipfs://ROOT2/chunk:0", contentId: "hash-b" }, // same content, brand-new uri
            { dataCid: "ipfs://ROOT2/chunk:1", contentId: "hash-c" }, // genuinely new
        ]);
        const d = diffManifests(parent, child);
        expect(d.added).toEqual(["hash-c"]);
        expect(d.removed).toEqual(["hash-a"]);
        // hash-b is shared despite the differing uri → not in either list
    });

    it("falls back to the uri for pre-contentId manifests", () => {
        expect(blobCids(recordSetManifest(["a", "b"]))).toEqual(["a", "b"]);
    });
});

describe("ObjectStore", () => {
    it("putCommit is deterministic: same logical commit ⇒ same CID", async () => {
        const store = new ObjectStore(new MemStore());
        const input = {
            parents: [] as string[],
            tree: "tree1",
            root: ROOT,
            schemaId: SCHEMA,
            author: AUTHOR,
            message: "initial import",
            timestamp: 1000,
        };
        const a = await store.putCommit(input);
        const b = await store.putCommit(input);
        expect(a.cid).toBe(b.cid);
        expect(isCommit(a.commit)).toBe(true);
    });

    it("round-trips a commit and rejects non-commit objects", async () => {
        const mem = new MemStore();
        const store = new ObjectStore(mem);
        const { cid } = await store.putCommit({
            parents: [], tree: "t", root: ROOT, schemaId: SCHEMA,
            author: AUTHOR, message: "m", timestamp: 1,
        });
        expect((await store.getCommit(cid)).message).toBe("m");

        const notCommit = await mem.put({ hello: "world" });
        await expect(store.getCommit(notCommit)).rejects.toThrow(/not a commit/);
    });

    it("walkParents yields the chain newest-first and respects limit", async () => {
        const store = new ObjectStore(new MemStore());
        const c1 = await store.putCommit({ parents: [], tree: "t1", root: ROOT, schemaId: SCHEMA, author: AUTHOR, message: "one", timestamp: 1 });
        const c2 = await store.putCommit({ parents: [c1.cid], tree: "t2", root: ROOT, schemaId: SCHEMA, author: AUTHOR, message: "two", timestamp: 2 });
        const c3 = await store.putCommit({ parents: [c2.cid], tree: "t3", root: ROOT, schemaId: SCHEMA, author: AUTHOR, message: "three", timestamp: 3 });

        const all: string[] = [];
        for await (const { commit } of store.walkParents(c3.cid)) all.push(commit.message);
        expect(all).toEqual(["three", "two", "one"]);

        const limited: string[] = [];
        for await (const { commit } of store.walkParents(c3.cid, 2)) limited.push(commit.message);
        expect(limited).toEqual(["three", "two"]);
    });

    it("diffCommit computes added/removed blobs against the first parent", async () => {
        const mem = new MemStore();
        const store = new ObjectStore(mem);

        const t1 = await mem.put(recordSetManifest(["places", "hours-v1"]));
        const c1 = await store.putCommit({ parents: [], tree: t1, root: ROOT, schemaId: SCHEMA, author: AUTHOR, message: "import", timestamp: 1 });

        const t2 = await mem.put(recordSetManifest(["places", "hours-v2"]));
        const c2 = await store.putCommit({ parents: [c1.cid], tree: t2, root: ROOT, schemaId: SCHEMA, author: AUTHOR, message: "fix hours", timestamp: 2 });

        const rootDiff = await store.diffCommit(c1.cid);
        expect(rootDiff.added.sort()).toEqual(["hours-v1", "places"]);

        const diff = await store.diffCommit(c2.cid);
        expect(diff.added).toEqual(["hours-v2"]);
        expect(diff.removed).toEqual(["hours-v1"]);
    });
});
