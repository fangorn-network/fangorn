/**
 * src/testing/settlement-registry.test.ts
 *
 * Integration tests for the SettlementRegistry two-phase flow.
 *
 * Run:
 *   npx vitest run settlement-registry.test.ts
 *   (or jest, mocha — swap describe/it/expect as needed)
 *
 * Requires:
 *   - A running Arbitrum Sepolia node or funded test accounts
 *   - OWNER_KEY, BUYER_KEY, BURNER_KEY in env (or .env file)
 *   - SettlementRegistry deployed at SETTLEMENT_REGISTRY_ADDRESS
 *   - (Optional) AccessNFTHook deployed at ACCESS_NFT_HOOK_ADDRESS
 */

import { describe, it, expect, beforeAll } from "vitest";
import { createWalletClient, http, parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { Identity } from "@semaphore-protocol/identity";
import { TestBed } from "./test/index.js";
import { SettlementRegistry } from "./interface/settlement-registry/index.js";

// ─── Env ──────────────────────────────────────────────────────────────────────

const RPC_URL     = process.env.RPC_URL     ?? "https://sepolia-rollup.arbitrum.io/rpc";
const OWNER_KEY   = (process.env.OWNER_KEY  ?? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80") as Hex;
const BUYER_KEY   = (process.env.BUYER_KEY  ?? "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d") as Hex;
const BURNER_KEY  = (process.env.BURNER_KEY ?? "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a") as Hex;
const PINATA_JWT  = process.env.PINATA_JWT  ?? "";
const PINATA_GW   = process.env.PINATA_GW   ?? "";

const SETTLEMENT_REGISTRY_ADDRESS    = (process.env.SETTLEMENT_REGISTRY_ADDRESS    ?? "0x4536881306ee355c2f18ae81658771c4488139a3") as Address;
const DATA_SOURCE_REGISTRY_ADDRESS   = (process.env.DATA_SOURCE_REGISTRY_ADDRESS   ?? "0x0") as Address;
const SCHEMA_REGISTRY_ADDRESS        = (process.env.SCHEMA_REGISTRY_ADDRESS        ?? "0x0") as Address;

const USDC_ADDRESS    = (process.env.USDC_ADDRESS ?? "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d") as Address;
const USDC_AMOUNT     = 1n;
const USDC_DOMAIN     = "USD Coin";

const CHAIN = arbitrumSepolia;

// Deterministic stealth address for tests — in production derive via EIP-5564
const STEALTH_ADDRESS = process.env.DELEGATEE_ETH_PRIVATE_KEY! as Address // "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeWallet(key: Hex) {
    return createWalletClient({
        account:   privateKeyToAccount(key),
        chain:     CHAIN,
        transport: http(RPC_URL),
    });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SettlementRegistry", () => {
    let testbed:    TestBed;
    let identity:   Identity;
    let schemaId:   Hex;
    let resourceId: Hex;

    const TAG       = `test-track-${Date.now()}`;
    const SCHEMA_ID = "0x0000000000000000000000000000000000000000000000000000000000000001" as Hex;

    beforeAll(async () => {
        const ownerWallet  = makeWallet(OWNER_KEY);
        const buyerWallet  = makeWallet(BUYER_KEY);

        testbed = await TestBed.init(
            ownerWallet,
            buyerWallet,
            PINATA_JWT,
            PINATA_GW,
            DATA_SOURCE_REGISTRY_ADDRESS,
            SCHEMA_REGISTRY_ADDRESS,
            SETTLEMENT_REGISTRY_ADDRESS,
            USDC_ADDRESS,
            USDC_DOMAIN,
            RPC_URL,
            "arbitrumSepolia",
            "arbitrum" as any,
            CHAIN.id,
        );

        // Fresh Semaphore identity for each test run
        identity = new Identity();

        // Derive resource_id from (owner, schemaId, tag)
        resourceId = SettlementRegistry.deriveResourceId(
            privateKeyToAccount(OWNER_KEY).address,
            SCHEMA_ID,
            TAG,
        );
    });

    // ── createResource ────────────────────────────────────────────────────────

    describe("createResource", () => {
        it("creates a Semaphore group for a new resource", async () => {
            const registry = testbed.getSettlementRegistry();
            const txHash = await registry.createResource(resourceId);
            expect(txHash).toMatch(/^0x[0-9a-f]{64}$/i);

            // Wait for confirmation
            const { createPublicClient, http } = await import("viem");
            const pc = createPublicClient({ chain: CHAIN, transport: http(RPC_URL) });
            const receipt = await pc.waitForTransactionReceipt({ hash: txHash });
            expect(receipt.status).toBe("success");

            // group_id should now be non-zero
            const groupId = await registry.getGroupId(resourceId);
            expect(groupId).toBeGreaterThan(USDC_AMOUNT);
        });

        // it("reverts when called again for the same resource", async () => {
        //     const registry = testbed.getSettlementRegistry();
        //     await expect(registry.createResource(resourceId)).rejects.toThrow();
        // });
    });

    // // ── register (Phase 1) ────────────────────────────────────────────────────

    // describe("register", () => {
    //     it("adds identity commitment to the group and emits MemberRegistered", async () => {
    //         const ownerAddress = privateKeyToAccount(OWNER_KEY).address;

    //         const txHash = await testbed.register(
    //             ownerAddress,
    //             SCHEMA_ID,
    //             TAG,
    //             identity,
    //             BURNER_KEY,
    //             USDC_AMOUNT,
    //         );
    //         expect(txHash).toMatch(/^0x[0-9a-f]{64}$/i);

    //         // isRegistered should now return true
    //         const registered = await testbed
    //             .getSettlementRegistry()
    //             .isRegistered(resourceId, identity.commitment);
    //         expect(registered).toBe(true);
    //     });

    //     it("reverts on double registration with same identity", async () => {
    //         const ownerAddress = privateKeyToAccount(OWNER_KEY).address;
    //         await expect(
    //             testbed.register(ownerAddress, SCHEMA_ID, TAG, identity, BURNER_KEY, USDC_AMOUNT)
    //         ).rejects.toThrow();
    //     });

    //     it("allows a different identity to register for the same resource", async () => {
    //         const ownerAddress = privateKeyToAccount(OWNER_KEY).address;
    //         const identity2    = new Identity();
    //         const txHash = await testbed.register(
    //             ownerAddress,
    //             SCHEMA_ID,
    //             TAG,
    //             identity2,
    //             BURNER_KEY,
    //             USDC_AMOUNT,
    //         );
    //         expect(txHash).toMatch(/^0x[0-9a-f]{64}$/i);
    //     });
    // });

    // // ── settle (Phase 2) ──────────────────────────────────────────────────────

    // describe("settle", () => {
    //     it("generates a valid ZK proof and settles, emitting SettlementFinalized", async () => {
    //         const ownerAddress = privateKeyToAccount(OWNER_KEY).address;

    //         const txHash = await testbed.settle(
    //             ownerAddress,
    //             SCHEMA_ID,
    //             TAG,
    //             identity,
    //             STEALTH_ADDRESS,
    //             BUYER_KEY,
    //         );
    //         expect(txHash).toMatch(/^0x[0-9a-f]{64}$/i);

    //         const { createPublicClient, http } = await import("viem");
    //         const pc = createPublicClient({ chain: CHAIN, transport: http(RPC_URL) });
    //         const receipt = await pc.waitForTransactionReceipt({ hash: txHash });
    //         expect(receipt.status).toBe("success");
    //     });

    //     it("reverts on double-settle (nullifier already used)", async () => {
    //         const ownerAddress = privateKeyToAccount(OWNER_KEY).address;
    //         await expect(
    //             testbed.settle(ownerAddress, SCHEMA_ID, TAG, identity, STEALTH_ADDRESS, BUYER_KEY)
    //         ).rejects.toThrow();
    //     });

    //     it("reverts if identity was never registered", async () => {
    //         const ownerAddress  = privateKeyToAccount(OWNER_KEY).address;
    //         const unregistered  = new Identity();
    //         await expect(
    //             testbed.settle(ownerAddress, SCHEMA_ID, TAG, unregistered, STEALTH_ADDRESS, BUYER_KEY)
    //         ).rejects.toThrow();
    //     });
    // });

    // // ── deriveResourceId ──────────────────────────────────────────────────────

    // describe("deriveResourceId", () => {
    //     it("is deterministic for the same (owner, schemaId, tag)", () => {
    //         const owner = privateKeyToAccount(OWNER_KEY).address;
    //         const a = SettlementRegistry.deriveResourceId(owner, SCHEMA_ID, TAG);
    //         const b = SettlementRegistry.deriveResourceId(owner, SCHEMA_ID, TAG);
    //         expect(a).toBe(b);
    //     });

    //     it("differs for different tags", () => {
    //         const owner = privateKeyToAccount(OWNER_KEY).address;
    //         const a = SettlementRegistry.deriveResourceId(owner, SCHEMA_ID, "tag-a");
    //         const b = SettlementRegistry.deriveResourceId(owner, SCHEMA_ID, "tag-b");
    //         expect(a).not.toBe(b);
    //     });

    //     it("differs for different owners", () => {
    //         const owner1 = privateKeyToAccount(OWNER_KEY).address;
    //         const owner2 = privateKeyToAccount(BUYER_KEY).address;
    //         const a = SettlementRegistry.deriveResourceId(owner1, SCHEMA_ID, TAG);
    //         const b = SettlementRegistry.deriveResourceId(owner2, SCHEMA_ID, TAG);
    //         expect(a).not.toBe(b);
    //     });
    // });

    // // ── decryptFile gate ──────────────────────────────────────────────────────
    // // These tests are skipped when Pinata creds are absent (CI without secrets).

    // describe.skipIf(!PINATA_JWT)("decryptFile (settlement-gated)", () => {
    //     let uploadedSchemaId: Hex;

    //     beforeAll(async () => {
    //         // Register a real schema so upload() works
    //         uploadedSchemaId = await testbed.registerSchema(
    //             "test-schema", "ipfs://test-spec", "test-agent"
    //         );
    //     });

    //     it("owner can decrypt their own file without settlement", async () => {
    //         const ownerAddress = privateKeyToAccount(OWNER_KEY).address;
    //         await testbed.fileUploadEmptyWallet(
    //             [{ tag: "owner-test", data: new Uint8Array([1, 2, 3]), extension: "bin", fileType: "application/octet-stream" }],
    //             uploadedSchemaId,
    //         );
    //         const data = await testbed.tryDecryptDelegator(ownerAddress, uploadedSchemaId, "owner-test");
    //         expect(data).toBeDefined();
    //     });

    //     it("buyer cannot decrypt before registering", async () => {
    //         const ownerAddress = privateKeyToAccount(OWNER_KEY).address;
    //         const freshIdentity = new Identity();
    //         await expect(
    //             testbed.tryDecrypt(ownerAddress, uploadedSchemaId, "owner-test", freshIdentity, true)
    //         ).rejects.toThrow("not registered");
    //     });

    //     it("buyer can decrypt after full register + settle flow", async () => {
    //         const ownerAddress  = privateKeyToAccount(OWNER_KEY).address;
    //         const buyerIdentity = new Identity();
    //         const buyerTag      = `gated-track-${Date.now()}`;

    //         // Upload new file (also calls createResource inside commit())
    //         await testbed.fileUploadEmptyWallet(
    //             [{ tag: buyerTag, data: new Uint8Array([4, 5, 6]), extension: "bin", fileType: "application/octet-stream" }],
    //             uploadedSchemaId,
    //         );

    //         // Phase 1
    //         await testbed.register(ownerAddress, uploadedSchemaId, buyerTag, buyerIdentity, BURNER_KEY, USDC_AMOUNT);

    //         // Phase 2
    //         await testbed.settle(ownerAddress, uploadedSchemaId, buyerTag, buyerIdentity, STEALTH_ADDRESS, BUYER_KEY);

    //         // Now decrypt should succeed
    //         const data = await testbed.tryDecrypt(
    //             ownerAddress, uploadedSchemaId, buyerTag, buyerIdentity, true
    //         );
    //         expect(data).toBeDefined();
    //         expect(data.length).toBeGreaterThan(0);
    //     });
    // });
});