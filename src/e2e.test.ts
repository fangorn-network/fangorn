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

const SK          = (process.env.DELEGATOR_ETH_PRIVATE_KEY  ?? "0xde0e6c1c331fcd8692463d6ffcf20f9f2e1847264f7a3f578cf54f62f05196cb") as Hex;
const BURNER_SK   = (process.env.DELEGATEE_ETH_PRIVATE_KEY  ?? "0xcbd236ee5a2fd07e8c9ef9198a23d869b7be792ca1ad76b35a6c67453839aaba") as Hex;
const RPC_URL     = process.env.RPC_URL ?? "https://sepolia-rollup.arbitrum.io/rpc";

const OWNER_KEY       = SK;
const FACILITATOR_KEY = SK;
const BURNER_KEY      = BURNER_SK;

const PINATA_JWT = process.env.PINATA_JWT ?? "";
const PINATA_GW  = process.env.PINATA_GATEWAY ?? "https://gateway.pinata.cloud";

const SETTLEMENT_REGISTRY_ADDRESS  = (process.env.SETTLEMENT_REGISTRY_ADDRESS  ?? "0x7c261c222beaa4f866e7f33de7704906d1245a2a") as Address;
const DATA_SOURCE_REGISTRY_ADDRESS = (process.env.DATA_SOURCE_REGISTRY_ADDRESS ?? "0x3941c7d50caa56f7f676554bc4e78d77aaf27ebb") as Address;
const SCHEMA_REGISTRY_ADDRESS      = (process.env.SCHEMA_REGISTRY_ADDRESS      ?? "0x49ab3d52b997e63ad56c91178df48263fd80b2dc") as Address;

const USDC_ADDRESS = (process.env.USDC_ADDRESS ?? "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d") as Address;
const USDC_AMOUNT  = 1n;
const USDC_DOMAIN  = "USD Coin";
const CAIP_2       = parseInt(process.env.CAIP2 ?? "421614");

const CHAIN = arbitrumSepolia;

const STEALTH_ADDRESS = privateKeyToAccount(BURNER_SK).address;
const hasIpfs = !!PINATA_JWT;

function makeWallet(key: Hex) {
    return createWalletClient({
        account: privateKeyToAccount(key),
        chain: CHAIN,
        transport: http(RPC_URL),
    });
}

const MUSIC_SCHEMA: SchemaDefinition = {
    title:  { "@type": "string" },
    artist: { "@type": "string" },
    audio:  { "@type": "encrypted", gadget: "settled" },
};

const ENCRYPTED_FIELD = "audio";

const TEST_RECORDS: PublishRecord[] = [
    {
        name: "track-01",
        fields: {
            title:  "Track One",
            artist: "Alice",
            audio:  { data: new Uint8Array([1, 2, 3, 4, 5]), fileType: "audio/mp3" },
        },
    },
    {
        name: "track-02",
        fields: {
            title:  "Track Two",
            artist: "Alice",
            audio:  { data: new Uint8Array([6, 7, 8, 9, 10]), fileType: "audio/mp3" },
        },
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
            agentId = "";
            schemaId = await testbed.registerSchema(schemaName, MUSIC_SCHEMA, agentId);
			console.log(schemaId)
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
                const manifestCid = await testbed.fileUpload(
                    TEST_RECORDS,
                    schemaName,
                    PINATA_GW,
                    price,
                );
                expect(manifestCid).toBeTruthy();
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

            describe("Consumer", () => {
                let buyerIdentity: Identity;
                const name = TEST_RECORDS[0].name;

                beforeAll(() => {
                    buyerIdentity = new Identity();
                });

                it("cannot decrypt before purchasing", async () => {
                    await expect(
                        testbed.tryDecrypt(
                            ownerAddress, 0n, SK,
                            schemaId, name, ENCRYPTED_FIELD,
                            RPC_URL, buyerIdentity, true,
                        ),
                    ).rejects.toThrow("not registered");
                });

                it("cannot decrypt when identity is missing and settlement is required", async () => {
                    await expect(
                        testbed.tryDecrypt(
                            ownerAddress, 0n, SK,
                            schemaId, name, ENCRYPTED_FIELD,
                            RPC_URL, undefined, true,
                        ),
                    ).rejects.toThrow("identity is required");
                });

                it("Phase 1: purchase — joins the Semaphore group", async () => {
                    const transferWithAuthPayload = await testbed.prepareRegister(
                        BURNER_KEY,
                        ownerAddress,
                        USDC_AMOUNT,
                    );

                    const txHash = await testbed.register(
                        ownerAddress,
                        schemaId,
                        name,
                        buyerIdentity.commitment,
                        FACILITATOR_KEY,
                        transferWithAuthPayload,
                    );

                    expect(txHash).toMatch(/^0x[0-9a-f]{64}$/i);

                    const resourceId = DataSourceRegistry.resourceIdLocal(ownerAddress, schemaId, name);
                    const registered = await testbed
                        .getSettlementRegistry()
                        .isRegistered(resourceId, buyerIdentity.commitment);
                    expect(registered).toBe(true);
                }, 30_000);

                it("Phase 2: claim — proves membership and fires access hook", async () => {
                    const payload = await testbed.prepareSettle(
                        ownerAddress, schemaId, name,
                        buyerIdentity, STEALTH_ADDRESS,
                    );

                    const { txHash, nullifier } = await testbed.settle(
                        ownerAddress, schemaId, name,
                        SK, payload,
                    );
                    nullifierHash = nullifier;

                    expect(txHash).toMatch(/^0x[0-9a-f]{64}$/i);

                    const resourceId = DataSourceRegistry.resourceIdLocal(ownerAddress, schemaId, name);
                    const isSettled = await testbed
                        .getDelegateeFangorn()
                        .getSettlementRegistry()
                        .isSettled(STEALTH_ADDRESS, resourceId);
                    expect(isSettled).toBe(true);
                }, 30_000);

                it("decrypt — buyer can read the file after full settlement", async () => {
                    const data = await testbed.tryDecrypt(
                        ownerAddress, nullifierHash, BURNER_KEY,
                        schemaId, name, ENCRYPTED_FIELD,
                        RPC_URL, buyerIdentity, true,
                    );
                    expect(data).toBeInstanceOf(Uint8Array);
                    expect(data.length).toBeGreaterThan(0);
                }, 30_000);
            });
        });
    });

    // describe("DataSourceRegistry.resourceIdLocal", () => {
    //     const STUB_SCHEMA_ID = "0x0000000000000000000000000000000000000000000000000000000000000001" as Hex;
    //     const NAME = "derive-test";

    //     it("is deterministic for the same (owner, schemaId, name)", () => {
    //         const a = DataSourceRegistry.resourceIdLocal(ownerAddress, STUB_SCHEMA_ID, NAME);
    //         const b = DataSourceRegistry.resourceIdLocal(ownerAddress, STUB_SCHEMA_ID, NAME);
    //         expect(a).toBe(b);
    //     });

    //     it("differs for different names", () => {
    //         const a = DataSourceRegistry.resourceIdLocal(ownerAddress, STUB_SCHEMA_ID, "name-a");
    //         const b = DataSourceRegistry.resourceIdLocal(ownerAddress, STUB_SCHEMA_ID, "name-b");
    //         expect(a).not.toBe(b);
    //     });

    //     it("differs for different schemaIds", () => {
    //         const schemaA = "0x0000000000000000000000000000000000000000000000000000000000000001" as Hex;
    //         const schemaB = "0x0000000000000000000000000000000000000000000000000000000000000002" as Hex;
    //         const a = DataSourceRegistry.resourceIdLocal(ownerAddress, schemaA, NAME);
    //         const b = DataSourceRegistry.resourceIdLocal(ownerAddress, schemaB, NAME);
    //         expect(a).not.toBe(b);
    //     });

    //     it("differs for different owners", () => {
    //         const addr1 = "0x0000000000000000000000000000000000000001" as Address;
    //         const addr2 = "0x0000000000000000000000000000000000000002" as Address;
    //         const a = DataSourceRegistry.resourceIdLocal(addr1, STUB_SCHEMA_ID, NAME);
    //         const b = DataSourceRegistry.resourceIdLocal(addr2, STUB_SCHEMA_ID, NAME);
    //         expect(a).not.toBe(b);
    //     });
    // });
});