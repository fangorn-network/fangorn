import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { TestBed } from "./test/index.js";
import { BundleInput, SchemaDefinition } from "./roles/schema/types.js";
import { FieldInput, PublishRecord } from "./roles/publisher/types.js";

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

        // it("should process and stream data seamlessly using an async iterable generator", async () => {
        //     const totalRecords = 3500;
        //     const chunkSize = 500; // Forces 7 full chunk cycles

        //     // Create an async generator to stream chunks dynamically
        //     async function* recordStreamGenerator() {
        //         for (let i = 0; i < totalRecords; i++) {
        //             yield {
        //                 name: `stream-rec-${i}`,
        //                 fields: { x: `Streaming generation line tracking element index: ${i}` }
        //             } as PublishRecord;
        //         }
        //     }

        //     const uniqueDatasetName = `ds.stream.${Date.now()}.${Math.random().toString(36).substring(2, 7)}`;

        //     const { manifestUri } = await testbed.getDelegatorFangorn().publisher.upload({
        //         records: recordStreamGenerator(),
        //         schemaName,
        //         datasetName: uniqueDatasetName,
        //         chunkSize,
        //         concurrency: 5
        //     });

        //     expect(manifestUri).toBeTruthy();
        //     createdManifestCids.push(manifestUri);

        //     // Pull verification entries from disparate chunks out of the generated manifest
        //     const intermediateEntry = await testbed.getDelegatorFangorn().publisher.getEntry(schemaName, "stream-rec-1750");
        //     expect(intermediateEntry).toBeDefined();
        //     expect(intermediateEntry.fields.x).toContain("1750");

        //     const finalEntry = await testbed.getDelegatorFangorn().publisher.getEntry(schemaName, `stream-rec-${totalRecords - 1}`);
        //     expect(finalEntry).toBeDefined();
        // }, 180_000);

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

            // publish tthe bundle onchain
            const manifestUri = await testbed.publishBundle(bundleName, nodes, edges, datasetName);
            expect(manifestUri).toBeTruthy();
            createdManifestCids.push(manifestUri);

            // manifest is a v3 bundle manifest: node chunks per type + one edge chunk
            const manifest = await testbed.getDelegatorFangorn()
                .publisher.getBundleManifestByCid(manifestUri);
            const graph = await testbed.getDelegatorFangorn()
                .publisher.readBundle(manifest!);

            expect(graph.nodesById.get("track-1")?.fields.title).toBe("Song One");
            expect(graph.nodesById.get("artist-1")?.fields.name).toBe("Alice");
            expect(graph.edges).toContainEqual({ rel: "performed_by", from: "track-1", to: "artist-1" });
            expect(manifest!.kind).toBe("bundle");
            expect(manifest!.nodeChunks).toHaveLength(2);           // Track + Artist
            expect(manifest!.edgeChunk?.dataCid).toBeTruthy();
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