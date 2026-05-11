import { describe, it, expect, beforeAll } from "vitest";
import {
    createWalletClient,
    http,
    type Address,
    type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { Identity } from "@semaphore-protocol/identity";
import { TestBed } from "./test/index.js";
import { SchemaDefinition } from "./roles/schema/types.js";
import { DataSourceRegistry } from "./registries/datasource-registry/index.js";
import { PublishRecord } from "./roles/publisher/types.js";

const SK = (process.env.DELEGATOR_ETH_PRIVATE_KEY ?? "0xde0e6c1c331fcd8692463d6ffcf20f9f2e1847264f7a3f578cf54f62f05196cb") as Hex;
const BURNER_SK = (process.env.DELEGATEE_ETH_PRIVATE_KEY ?? "0xcbd236ee5a2fd07e8c9ef9198a23d869b7be792ca1ad76b35a6c67453839aaba") as Hex;
const RPC_URL = process.env.RPC_URL ?? "https://sepolia-rollup.arbitrum.io/rpc";
const WORKER_URL = process.env.WORKER_URL ?? "http://localhost:8787";

const OWNER_KEY = SK;
const FACILITATOR_KEY = SK;
const BURNER_KEY = BURNER_SK;

const PINATA_JWT = process.env.PINATA_JWT ?? "";
const PINATA_GW = process.env.PINATA_GATEWAY ?? "https://gateway.pinata.cloud";

const SETTLEMENT_REGISTRY_ADDRESS = (process.env.SETTLEMENT_REGISTRY_ADDRESS ?? "0x7c261c222beaa4f866e7f33de7704906d1245a2a") as Address;
const DATA_SOURCE_REGISTRY_ADDRESS = (process.env.DATA_SOURCE_REGISTRY_ADDRESS ?? "0x3941c7d50caa56f7f676554bc4e78d77aaf27ebb") as Address;
const SCHEMA_REGISTRY_ADDRESS = (process.env.SCHEMA_REGISTRY_ADDRESS ?? "0x49ab3d52b997e63ad56c91178df48263fd80b2dc") as Address;

const USDC_ADDRESS = (process.env.USDC_ADDRESS ?? "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d") as Address;
const USDC_AMOUNT = 1n;
const USDC_DOMAIN = "USD Coin";
const CAIP_2 = parseInt(process.env.CAIP2 ?? "421614");

const CHAIN = arbitrumSepolia;

const STEALTH_ADDRESS = privateKeyToAccount(BURNER_SK).address;
const hasIpfs = !!PINATA_JWT;
const hasWorker = !!process.env.WORKER_URL;

function makeWallet(key: Hex) {
    return createWalletClient({
        account: privateKeyToAccount(key),
        chain: CHAIN,
        transport: http(RPC_URL),
    });
}


const ENCRYPTED_FIELD = "audio";

// const MUSIC_SCHEMA: SchemaDefinition = {
//     title: { "@type": "string" },
//     artist: { "@type": "string" },
//     genres: { "@type": "array", items: { "@type": "string" } },
//     audio: { "@type": "handle" },
// };

// // r2:// URIs — content already uploaded to R2 out-of-band
// const TEST_RECORDS: PublishRecord[] = [
//     {
//         name: "track-01",
//         fields: {
//             title: "Track One",
//             artist: "Alice",
//             genres: ["test1", "examen 1"],
//             audio: { "@type": "handle", uri: "r2://tracks/track-01.mp3", workerUrl: process.env.WORKER_URL ?? "" },
//         },
//     },
//     {
//         name: "track-02",
//         fields: {
//             title: "Track Two",
//             artist: "Alice",
//             genres: ["test2", "testTwo"],
//             audio: { "@type": "handle", uri: "r2://tracks/track-02.mp3", workerUrl: process.env.WORKER_URL ?? "" },
//         },
//     },
// ];

const MUSIC_SCHEMA: SchemaDefinition = {
    "mbid": {
        "@type": "string | null"
    },
    "title": {
        "@type": "string"
    },
    "artist": {
        "@type": "string"
    },
    "year": {
        "@type": "number"
    },
    "energy": {
        "@type": "number"
    },
    "genres": {
        "@type": "array",
        "items": {
            "@type": "string"
        }
    },
    "moods": {
        "@type": "array",
        "items": {
            "@type": "string"
        }
    },
    "themes": {
        "@type": "array",
        "items": {
            "@type": "string"
        }
    },
    "contexts": {
        "@type": "array",
        "items": {
            "@type": "string"
        }
    }
};

// r2:// URIs — content already uploaded to R2 out-of-band
const TEST_RECORDS: PublishRecord[] = [
    {
        "name": "1b41c446-dbb4-4977-8d23-87496a199af9",
        "fields": {
            "mbid": "1b41c446-dbb4-4977-8d23-87496a199af9",
            "title": "Analogue Bubblebath 3",
            "artist": "Aphex Twin",
            "year": 1993,
            "energy": 3,
            "genres": [
                "ambient techno",
                "idm",
                "rave"
            ],
            "moods": [
                "hypnotic",
                "dreamy",
                "euphoric",
                "floating"
            ],
            "themes": [
                "altered states",
                "synthesis",
                "abstraction"
            ],
            "contexts": [
                "late-night",
                "headphone-listening",
                "art-installation"
            ]
        }
    },
    {
        "name": "e1c3580b-1c05-4984-94f7-ac88ac9834ee",
        "fields": {
            "mbid": null,
            "title": "To Cure a Weakling Child",
            "artist": "Aphex Twin",
            "year": 1997,
            "energy": 2,
            "genres": [
                "idm",
                "experimental electronic",
                "ambient"
            ],
            "moods": [
                "melancholic",
                "unsettling",
                "tender",
                "strange"
            ],
            "themes": [
                "vulnerability",
                "healing",
                "fragility"
            ],
            "contexts": [
                "late-night-listening",
                "headphone-listening",
                "art-installation"
            ]
        }
    },
];

describe("Fangorn E2E", () => {
    let testbed: TestBed;
    let ownerAddress: Address;

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

    describe.skipIf(!hasIpfs)("Alice: schema owner", () => {
        let schemaName: string;
        let agentId: string;
        let schemaId: Hex;
        let nullifierHash: bigint;
        const price = 1n;

        it("registers a schema on-chain", async () => {
            schemaName = `fangorn.music.test.${Date.now()}`;
            console.log('register schema with name ' + schemaName)
            agentId = "";
            schemaId = await testbed.registerSchema(schemaName, MUSIC_SCHEMA, agentId);
            console.log(schemaId);
            expect(schemaId).toMatch(/^0x[0-9a-f]{64}$/i);
        }, 30_000);

        it("can fetch the registered schema by id", async () => {
            const schema = await testbed.getDelegatorFangorn().schema.get(schemaName);
            expect(schema).toBeDefined();
            expect(schema!.definition).toMatchObject(MUSIC_SCHEMA);
            expect(schema!.agentId).toBe(agentId);
            expect(schema!.owner.toLowerCase()).toBe(ownerAddress.toLowerCase());
        }, 60_000);

        describe("Publisher", () => {
            it("uploads multiple records and publishes a manifest", async () => {
                const manifestUri = await testbed.fileUpload(
                    TEST_RECORDS,
                    schemaName,
                    price,
                );
                expect(manifestUri).toBeTruthy();
            }, 60_000);

            it("manifest exists on-chain after upload", async () => {
                const exists = await testbed.checkManifestExists(
                    ownerAddress,
                    schemaId,
                    TEST_RECORDS[0].name,
                );
                expect(exists).toBe(true);
            }, 30_000);

            it("both entries are present in the manifest", async () => {
                for (const record of TEST_RECORDS) {
                    const exists = await testbed.checkEntryExists(ownerAddress, schemaId, record.name);
                    expect(exists).toBe(true);
                }
            }, 30_000);

            // describe("Consumer", () => {
            //     let buyerIdentity: Identity;
            //     // const name = "locura.mp3"
            //     // schemaId = "";
            //     const name = TEST_RECORDS[0].name;

            //     beforeAll(() => {
            //         buyerIdentity = new Identity();
            //     });

            //     it("Phase 1: purchase joins the Semaphore group", async () => {
            //         // burner to owner
            //         const transferWithAuthPayload = await testbed.prepareRegister(
            //             BURNER_KEY,
            //             ownerAddress,
            //             USDC_AMOUNT,
            //         );

            //         // identity registers in the sempaphore group
            //         const txHash = await testbed.register(
            //             ownerAddress,
            //             schemaId,
            //             name,
            //             buyerIdentity.commitment,
            //             FACILITATOR_KEY,
            //             transferWithAuthPayload,
            //         );

            //         expect(txHash).toMatch(/^0x[0-9a-f]{64}$/i);

            //         const resourceId = DataSourceRegistry.resourceIdLocal(ownerAddress, schemaId, name);
            //         const registered = await testbed
            //             .getSettlementRegistry()
            //             .isRegistered(resourceId, buyerIdentity.commitment);
            //         expect(registered).toBe(true);
            //     }, 30_000);

            //     it("Phase 2: settle", async () => {
            //         const payload = await testbed.prepareSettle(
            //             ownerAddress, schemaId, name,
            //             buyerIdentity, STEALTH_ADDRESS,
            //         );

            //         const { txHash, nullifier } = await testbed.settle(
            //             ownerAddress, schemaId, name,
            //             BURNER_SK, payload,
            //         );
            //         nullifierHash = nullifier;

            //         expect(txHash).toMatch(/^0x[0-9a-f]{64}$/i);

            //         const resourceId = DataSourceRegistry.resourceIdLocal(ownerAddress, schemaId, name);

            //         const isSettled = await testbed
            //             .getDelegateeFangorn()
            //             .getSettlementRegistry()
            //             .isSettled(STEALTH_ADDRESS, resourceId);
            //         expect(isSettled).toBe(true);
            //     }, 30_000);

            //     it.skipIf(!hasWorker)("Phase 3: fetch - buyer retrieves content via worker", async () => {
            //         const data = await testbed.fetchContent(
            //             ownerAddress,
            //             schemaId,
            //             name,
            //             ENCRYPTED_FIELD,
            //             nullifierHash.toString(),
            //             BURNER_KEY,
            //         );
            //         expect(data).toBeInstanceOf(Uint8Array);
            //         expect(data.length).toBeGreaterThan(0);
            //     }, 30_000);

            //     it.skipIf(!hasWorker)("Phase 3: fetch fails without settlement", async () => {
            //         const unsettledIdentity = new Identity();
            //         // use a fresh keypair that was never settled
            //         const freshKey = "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;
            //         await expect(
            //             testbed.fetchContent(
            //                 ownerAddress,
            //                 schemaId,
            //                 name,
            //                 ENCRYPTED_FIELD,
            //                 "0",
            //                 freshKey,
            //             ),
            //         ).rejects.toThrow("not settled");
            //     }, 30_000);
            // });
        });
    });
});