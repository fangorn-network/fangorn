import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { TestBed } from "./test/index.js";
import { BundleInput, SchemaDefinition, TypeDefinition } from "./roles/schema/types.js";
import { FieldInput, PublishRecord } from "./roles/publisher/types.js";
import { ObjectStore, blobCids, blobRefs } from "./objects/store.js";
import { LocalRepo } from "./roles/repo/index.js";

const SK = process.env.DELEGATOR_ETH_PRIVATE_KEY as Hex;
const RPC_URL = process.env.RPC_URL ?? "https://sepolia-rollup.arbitrum.io/rpc";
const WORKER_URL = process.env.WORKER_URL ?? "http://localhost:8787";

const OWNER_KEY = SK;
const PINATA_JWT = process.env.PINATA_JWT;

const SETTLEMENT_REGISTRY_ADDRESS = process.env.SETTLEMENT_REGISTRY_ADDRESS as Address;
const DATA_SOURCE_REGISTRY_ADDRESS = process.env.DATA_SOURCE_REGISTRY_ADDRESS as Address;
const SCHEMA_REGISTRY_ADDRESS = process.env.SCHEMA_REGISTRY_ADDRESS as Address;

const USDC_ADDRESS = (process.env.USDC_ADDRESS ?? "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d") as Address;
const USDC_DOMAIN = "USD Coin";

const CHAIN = arbitrumSepolia;
const hasIpfs = !!PINATA_JWT;

function makeWallet(key: Hex) {
    return createWalletClient({
        account: privateKeyToAccount(key),
        chain: CHAIN,
        transport: http(RPC_URL),
    });
}

const ULTRA_SIMPLE_SCHEMA: SchemaDefinition = {
    "x": { "@type": "string" }
};

const createdManifestCids: string[] = [];

describe("Fangorn Publisher E2E", () => {

    let testbed: TestBed;
    let ownerAddress: Address;

    let schemaName: string;

    beforeAll(async () => {
        testbed = await TestBed.init(
            makeWallet(OWNER_KEY),
            DATA_SOURCE_REGISTRY_ADDRESS,
            SCHEMA_REGISTRY_ADDRESS,
            SETTLEMENT_REGISTRY_ADDRESS,
            USDC_ADDRESS,
            USDC_DOMAIN,
            RPC_URL,
            "arbitrumSepolia",
            CHAIN.id,
            WORKER_URL,
        );

        ownerAddress = privateKeyToAccount(OWNER_KEY).address;
    });

    afterAll(async () => {
        // cleanup files after runs
        if (!hasIpfs || createdManifestCids.length === 0) return;
        console.log(`\n--- Starting Storage Cleanup Pass (${createdManifestCids.length} entries) ---`);

        for (const mCid of createdManifestCids) {
            try {
                await unpinFromPinata(mCid);
            } catch (err) {
                console.error(`Cleanup failure for CID tracking index ${mCid}:`, err);
            }
        }
    }, 60_000);


    describe.skipIf(!hasIpfs)("Schema", () => {

        it("should register a schema successfully", async () => {
            // register a schema with a unique name
            schemaName = `fangorn.simple.test.${Date.now()}.${Math.random().toString(36).substring(2, 5)}`;
            await testbed.registerSchema(schemaName, ULTRA_SIMPLE_SCHEMA);
            // verify that the schema exists
            const schema = await testbed.getDelegatorFangorn().schema.get(schemaName);
            expect(schema).toBeDefined();
            expect(schema?.kind).toBe("resolver");

            if (schema?.kind !== "resolver") throw new Error("expected resolver schema");
            expect(schema.definition).toMatchObject(ULTRA_SIMPLE_SCHEMA);
            expect(schema.owner.toLowerCase()).toBe(ownerAddress.toLowerCase());
        }, 60_000)
    })

    describe.skipIf(!hasIpfs)("Publish", () => {

        /**
         * we are publishing a record that looks like:
         * 
         * {
         *   "name": "simple-0",
         *   "fields": { "x": "Hello, Fangorn: [date].[random]" }
         * }
         * 
         * to the schema registered above
         * 
         */
        it("should upload a single simple record successfully inside a unified chunk", async () => {
            const singleRecord: PublishRecord[] = [
                {
                    name: "simple-0",
                    fields: { x: `Hello, Fangorn: ${Date.now()}.${Math.random().toString(36).substring(2, 5)}` }
                }
            ];

            // random name for dataset
            const uniqueDatasetName = `ds.single.${Date.now()}.${Math.random().toString(36).substring(2, 7)}`;
            const manifestUri = await testbed.publish(singleRecord, schemaName, uniqueDatasetName);

            expect(manifestUri).toBeTruthy();
            createdManifestCids.push(manifestUri);

            // and we can read the entry too
            const manifest = await testbed.getDelegatorFangorn().publisher.getManifest(schemaName, uniqueDatasetName);
            expect(manifest).toBeTruthy();

        }, 60_000);

        /**
          * The SDK chunks records so that you don't need to have a million leaf merkle tree
          */
        it("should chunk a larger array payload and build a valid Merkle tree", async () => {
            const recordCount = 2500;
            // default chunkSize = 1000;
            const recordsArray: PublishRecord[] = Array.from({ length: recordCount }, (_, idx) => ({
                name: `array-rec-${idx}`,
                fields: { x: `${idx}` }
            }));

            const uniqueDatasetName = `ds.array.${Date.now()}.${Math.random().toString(36).substring(2, 7)}`;

            const manifestUri = await testbed.publish(recordsArray, schemaName, uniqueDatasetName);
            expect(manifestUri).toBeTruthy();
            createdManifestCids.push(manifestUri);

            // Verify a record inside the first chunk and one in the last partial chunk
            const firstEntry = await testbed.getDelegatorFangorn()
                .publisher
                .getEntry(schemaName, uniqueDatasetName, "array-rec-0");
            expect(firstEntry).toBeDefined();

            const lastEntry = await testbed.getDelegatorFangorn()
                .publisher
                .getEntry(schemaName, uniqueDatasetName, `array-rec-${recordCount - 1}`);
            expect(lastEntry).toBeDefined();
            expect(lastEntry.fields.x).toBe(`${recordCount - 1}`);

        }, 120_000);

    });

    describe.skipIf(!hasIpfs)("Constraints", () => {
        let constrainedSchema: string;

        // a field-level constraint plus a `payment` custom type whose nested
        // fields each carry their own constraints
        const PRICED_SCHEMA: SchemaDefinition = {
            title: { "@type": "string", constraints: [{ kind: "length", min: 1, max: 200 }] },
            price: { "@type": "payment" },
        };
        const PRICED_TYPES: Record<string, TypeDefinition> = {
            payment: {
                shape: {
                    amount: { "@type": "string", constraints: [{ kind: "regex", pattern: "^[0-9]+$" }] },
                    currency: { "@type": "string", constraints: [{ kind: "enum", values: ["USDC", "USDT", "DAI"] }] },
                },
            },
        };

        beforeAll(async () => {
            constrainedSchema = `fangorn.priced.${Date.now()}.${Math.random().toString(36).substring(2, 5)}`;
            await testbed.registerSchema(constrainedSchema, PRICED_SCHEMA, PRICED_TYPES);
            // custom types must survive the round-trip through storage
            const reg = await testbed.getDelegatorFangorn().schema.get(constrainedSchema);
            if (reg?.kind !== "resolver") throw new Error("expected resolver schema");
            expect(reg.types?.payment).toBeDefined();
        }, 90_000);

        it("publishes a record that satisfies all constraints", async () => {
            const records: PublishRecord[] = [
                {
                    name: "priced-ok",
                    fields: { title: "Atom Heart Mother", price: { amount: "5000000", currency: "USDC" } },
                },
            ];
            const datasetName = `ds.priced.ok.${Date.now()}.${Math.random().toString(36).substring(2, 7)}`;

            const manifestUri = await testbed.publish(records, constrainedSchema, datasetName);
            expect(manifestUri).toBeTruthy();
            createdManifestCids.push(manifestUri);

            const entry = await testbed.getDelegatorFangorn()
                .publisher.getEntry(constrainedSchema, datasetName, "priced-ok");
            expect(entry).toBeDefined();
        }, 90_000);

        it("rejects a record that violates a nested constraint at publish time", async () => {
            const records: PublishRecord[] = [
                {
                    name: "priced-bad",
                    // amount has a decimal — fails the payment.amount regex
                    fields: { title: "Atom Heart Mother", price: { amount: "5.5", currency: "USDC" } },
                },
            ];
            const datasetName = `ds.priced.bad.${Date.now()}.${Math.random().toString(36).substring(2, 7)}`;

            await expect(
                testbed.publish(records, constrainedSchema, datasetName),
            ).rejects.toThrow(/price\.amount/);
        }, 60_000);
    });

    describe.skipIf(!hasIpfs)("Bundle", () => {
        let trackSchema: string;
        let artistSchema: string;
        let bundleName: string;

        const TRACK_SCHEMA: SchemaDefinition = {
            title: { "@type": "string" },
        };
        const ARTIST_SCHEMA: SchemaDefinition = {
            name: { "@type": "string" },
        };

        it("registers the resolver node schemas", async () => {
            const suffix = `${Date.now()}.${Math.random().toString(36).substring(2, 5)}`;
            trackSchema = `fangorn.track.${suffix}`;
            artistSchema = `fangorn.artist.${suffix}`;

            await testbed.registerSchema(trackSchema, TRACK_SCHEMA);
            await testbed.registerSchema(artistSchema, ARTIST_SCHEMA);

            const t = await testbed.getDelegatorFangorn().schema.get(trackSchema);
            const a = await testbed.getDelegatorFangorn().schema.get(artistSchema);
            expect(t?.kind).toBe("resolver");
            expect(a?.kind).toBe("resolver");
        }, 90_000);

        /**
         * Here we are publishing a new schema for the bundle
         */
        it("registers a bundle shape over Track and Artist", async () => {
            bundleName = `fangorn.music.bundle.${Date.now()}.${Math.random().toString(36).substring(2, 5)}`;

            console.log("Publishing the bundle name " + bundleName);

            // define the bundle, encodes relationships between schemas and how they join
            const bundle: BundleInput = {
                nodes: { Track: trackSchema, Artist: artistSchema },
                edges: [{ rel: "performed_by", from: "Track", to: "Artist", min: 1, max: 1 }],
            };

            await testbed.registerBundle(bundleName, bundle);
            // the bundle should exist
            const registered = await testbed.getDelegatorFangorn().schema.get(bundleName);
            expect(registered?.kind).toBe("bundle");

            if (registered?.kind !== "bundle") throw new Error("expected bundle schema");
            expect(registered.bundle.nodes.Track).toMatch(/^0x[0-9a-f]{64}$/i);
        }, 90_000);

        it("publishes a Track+Artist bundle in a single commitment", async () => {
            // unique name for the collection
            const datasetName = `ds.bundle.${Date.now()}.${Math.random().toString(36).substring(2, 7)}`;

            // each node is a schema
            const nodes: { id: string; type: string; fields: Record<string, FieldInput> }[] = [
                { id: "artist-1", type: "Artist", fields: { name: "Alice" } },
                { id: "track-1", type: "Track", fields: { title: "Song One" } },
            ];

            // defines how edges are connected
            const edges = [{ rel: "performed_by", from: "track-1", to: "artist-1" }];

            // publish the bundle onchain
            const manifestUri = await testbed.publishBundle(bundleName, nodes, edges, datasetName);
            expect(manifestUri).toBeTruthy();
            createdManifestCids.push(manifestUri);

            const manifest = await testbed.getDelegatorFangorn()
                .publisher.getBundleManifestByCid(manifestUri);
            // 'unbundle'     
            const graph = await testbed.getDelegatorFangorn()
                .publisher.readBundle(manifest!);

            expect(graph.nodesById.get("track-1")?.fields.title).toBe("Song One");
            expect(graph.nodesById.get("artist-1")?.fields.name).toBe("Alice");
            expect(graph.edges).toContainEqual({ rel: "performed_by", from: "track-1", to: "artist-1" });
            expect(manifest!.kind).toBe("bundle");
            expect(manifest!.nodeChunks).toHaveLength(2);           // Track + Artist
            expect(manifest!.edgeChunks[0].dataCid).toBeTruthy();
        }, 90_000);

        it("rejects a bundle whose edge violates min cardinality", async () => {
            const datasetName = `ds.bundle.bad.${Date.now()}`;
            const nodes = [
                { id: "track-x", type: "Track", fields: { title: "Orphan" } },
            ];
            // performed_by min=1 but no edge supplied
            await expect(
                testbed.publishBundle(bundleName, nodes, [], datasetName),
            ).rejects.toThrow(/min 1|cardinality/i);
        }, 60_000);
    });

    // ── Git-native repo flow (slice 1): commit → push → history → diff → clone ──
    //
    // Exercises the whole S1 acceptance list against real IPFS + the deployed
    // contract: parented commits with the commit CID riding in the manifest_cid
    // slot, structural sharing across commits, deletes via omission, the
    // client-side fast-forward guard, and reconstructing full history from IPFS
    // alone (no subgraph). See docs/GIT_NATIVE_IMPLEMENTATION_PLAN.md S1.
    describe.skipIf(!hasIpfs)("Git-native repo", () => {
        let repoSchema: string;
        let datasetName: string;
        let commit1: string;
        let commit2: string;
        let root1: Hex;

        const publisher = () => testbed.getDelegatorFangorn().publisher;
        const store = () => new ObjectStore(testbed.getDelegatorFangorn().getStorage());

        beforeAll(async () => {
            repoSchema = `fangorn.repo.${Date.now()}.${Math.random().toString(36).substring(2, 5)}`;
            await testbed.registerSchema(repoSchema, ULTRA_SIMPLE_SCHEMA);
            datasetName = `ds.repo.${Date.now()}.${Math.random().toString(36).substring(2, 7)}`;
        }, 90_000);

        it("commits an initial snapshot and pushes it as the tip", async () => {
            // chunkSize:1 → one blob per record, so a later edit can *share* the
            // unchanged record's blob and only re-upload what changed.
            const c1 = await publisher().commitRecords({
                records: [
                    { name: "rec-a", fields: { x: "alpha" } },
                    { name: "rec-b", fields: { x: "bravo" } },
                ],
                schemaName: repoSchema,
                datasetName,
                parents: [],
                message: "initial import",
                chunkSize: 1,
            });
            commit1 = c1.commitCid;
            root1 = c1.root;
            createdManifestCids.push(c1.commitCid, c1.manifestCid);
            expect(c1.parents).toEqual([]);

            await publisher().push({
                commitCid: c1.commitCid,
                root: c1.root,
                schemaId: c1.schemaId,
                datasetName,
                expectedParent: undefined,
            });

            const owner = testbed.getDelegatorAddress();
            const tip = await publisher().resolveTip(owner, c1.schemaId, datasetName);
            expect(tip).toBe(commit1);
        }, 120_000);

        it("commits a second snapshot (drop rec-a, add rec-c) that fast-forwards the tip", async () => {
            const c2 = await publisher().commitRecords({
                records: [
                    { name: "rec-b", fields: { x: "bravo" } }, // unchanged → shared blob
                    { name: "rec-c", fields: { x: "charlie" } }, // new
                    // rec-a omitted → deleted from current state
                ],
                schemaName: repoSchema,
                datasetName,
                parents: [commit1],
                message: "drop rec-a, add rec-c",
                chunkSize: 1,
            });
            commit2 = c2.commitCid;
            createdManifestCids.push(c2.commitCid, c2.manifestCid);
            expect(c2.parents).toEqual([commit1]);
            // Structural sharing: rec-b was byte-identical to the parent's chunk, so
            // it was reused (not re-uploaded); only rec-c hit the network.
            expect(c2.reusedCount).toBe(1);
            expect(c2.uploadedCount).toBe(1);

            await publisher().push({
                commitCid: c2.commitCid,
                root: c2.root,
                schemaId: c2.schemaId,
                datasetName,
                expectedParent: commit1, // fast-forward from the current tip
            });

            const owner = testbed.getDelegatorAddress();
            expect(await publisher().resolveTip(owner, c2.schemaId, datasetName)).toBe(commit2);
        }, 120_000);

        it("walks parented history from the tip using IPFS only", async () => {
            const messages: string[] = [];
            for await (const { commit } of store().walkParents(commit2)) messages.push(commit.message);
            expect(messages).toEqual(["drop rec-a, add rec-c", "initial import"]);
        }, 90_000);

        it("diffs the second commit: rec-c added, rec-a removed, rec-b shared", async () => {
            const diff = await store().diffCommit(commit2);
            // Row-fine diff: exactly one chunk added (rec-c) and one removed (rec-a).
            expect(diff.added).toHaveLength(1);
            expect(diff.removed).toHaveLength(1);

            // Structural sharing holds: rec-b's chunk has the same contentId in both
            // commits even though its retrieval uri differs (new CAR). Diffing on
            // contentId (not the uri) makes it shared — so quickbeam re-embeds only
            // the delta (PROTOCOL.md §4).
            const c1Tree = await store().getTree(await store().getCommit(commit1));
            const c2Tree = await store().getTree(await store().getCommit(commit2));
            const shared = blobCids(c1Tree).filter(c => blobCids(c2Tree).includes(c));
            expect(shared).toHaveLength(1); // rec-b's chunk, reused byte-for-byte
        }, 90_000);

        it("rejects a stale push (non-fast-forward guard)", async () => {
            // Re-pushing commit1 now: on-chain tip is commit2, but commit1 claims
            // no parent → not a fast-forward, must be refused.
            await expect(
                publisher().push({
                    commitCid: commit1,
                    root: root1,
                    schemaId: await testbed.getDelegatorFangorn().getSchemaRegistry().schemaId(repoSchema),
                    datasetName,
                    expectedParent: undefined,
                }),
            ).rejects.toThrow(/non-fast-forward/);
        }, 60_000);

        it("clones: reconstructs HEAD, history, and current records from IPFS alone", async () => {
            const owner = testbed.getDelegatorAddress();
            const schemaId = await testbed.getDelegatorFangorn().getSchemaRegistry().schemaId(repoSchema);
            const storage = testbed.getDelegatorFangorn().getStorage();

            // 1) resolve the single trusted pointer, then rebuild everything below it
            const tip = await publisher().resolveTip(owner, schemaId, datasetName);
            expect(tip).toBe(commit2);

            // 2) write a fresh local repo pointed at the tip (what `fangorn clone` does)
            const dir = mkdtempSync(join(tmpdir(), "fangorn-clone-"));
            try {
                const repo = LocalRepo.init({ name: datasetName, schema: repoSchema, schemaId, owner }, dir);
                repo.setHead(tip!);
                // reopen to prove it persisted, and walk history from the cloned HEAD
                const reopened = LocalRepo.open(dir);
                expect(reopened.head()).toBe(commit2);

                let count = 0;
                for await (const _s of store().walkParents(reopened.head()!)) { void _s; count++; }
                expect(count).toBe(2);

                // 3) reconstruct the *current* record set from the tip's tree blobs.
                //    Fetch by the retrieval uri (blobRefs.uri) — note rec-b's uri is
                //    the parent commit's, reused via structural sharing, and still
                //    resolves because that CAR stays pinned.
                const tree = await store().getTree(await store().getCommit(tip!));
                const names = new Set<string>();
                for (const { uri } of blobRefs(tree)) {
                    const chunk = await storage.get<{ name: string }[]>(uri);
                    for (const rec of chunk) names.add(rec.name);
                }
                expect(names.has("rec-b")).toBe(true);
                expect(names.has("rec-c")).toBe(true);
                expect(names.has("rec-a")).toBe(false); // deleted in commit2
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        }, 120_000);
    });
});

async function unpinFromPinata(cid: string): Promise<void> {
    try {
        const response = await fetch(`https://api.pinata.cloud/pinning/unpin/${cid}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${PINATA_JWT}` }
        });
        if (response.ok) {
            console.log(`Successfully unpinned remote storage hash target: ${cid}`);
        } else {
            console.warn(`Unpin validation rejection response for tracking hash ${cid}: ${response.statusText}`);
        }
    } catch (err) {
        console.warn(`Failed endpoint transaction on unpin execution route for asset ${cid}`);
    }
}