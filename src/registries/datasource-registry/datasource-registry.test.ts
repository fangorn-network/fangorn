import { describe, it, expect, vi, beforeEach } from "vitest";
import { DataSourceRegistry } from "./index.js";
import type { Address, Hash, Hex } from "viem";

// --- Shared test fixtures ---

const CONTRACT_ADDRESS: Address = "0x1111111111111111111111111111111111111111";
const SCHEMA_REGISTRY_ADDRESS: Address = "0x2222222222222222222222222222222222222222";
const OWNER_ADDRESS: Address = "0x3333333333333333333333333333333333333333";

const MOCK_SCHEMA_ID: Hex = "0xdeadbeef00000000000000000000000000000000000000000000000000000000";
const MOCK_TX_HASH: Hash = "0xaabbccdd00000000000000000000000000000000000000000000000000000000";
const MOCK_MANIFEST_CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

// --- Mock factory ---

function makeMockReceipt() {
    return { status: "success", blockNumber: 1n };
}

function makeClients({
    readContractImpl,
    estimateContractGasImpl,
    estimateFeesPerGasImpl,
    writeContractImpl,
    waitForTransactionReceiptImpl,
}: {
    readContractImpl?: (...args: unknown[]) => unknown;
    estimateContractGasImpl?: () => bigint;
    estimateFeesPerGasImpl?: () => { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
    writeContractImpl?: () => Hash;
    waitForTransactionReceiptImpl?: () => unknown;
} = {}) {
    const publicClient = {
        readContract: vi.fn(readContractImpl ?? (() => undefined)),
        estimateContractGas: vi.fn(estimateContractGasImpl ?? (() => 100_000n)),
        estimateFeesPerGas: vi.fn(
            estimateFeesPerGasImpl ??
                (() => ({ maxFeePerGas: 10n, maxPriorityFeePerGas: 1n }))
        ),
        waitForTransactionReceipt: vi.fn(
            waitForTransactionReceiptImpl ?? (() => makeMockReceipt())
        ),
    };

    const walletClient = {
        chain: { id: 42161, name: "Arbitrum One" },
        account: { address: OWNER_ADDRESS },
        writeContract: vi.fn(writeContractImpl ?? (() => MOCK_TX_HASH)),
    };

    return { publicClient, walletClient };
}

// --- Tests ---

describe("DataSourceRegistry", () => {
    describe("constructor / getContractAddress", () => {
        it("returns the contract address it was initialized with", () => {
            const { publicClient, walletClient } = makeClients();
            const registry = new DataSourceRegistry(
                CONTRACT_ADDRESS,
                publicClient as never,
                walletClient as never,
            );
            expect(registry.getContractAddress()).toBe(CONTRACT_ADDRESS);
        });
    });

    describe("initialize", () => {
        it("calls writeContract with the schema registry address and returns the tx hash", async () => {
            const { publicClient, walletClient } = makeClients();
            const registry = new DataSourceRegistry(
                CONTRACT_ADDRESS,
                publicClient as never,
                walletClient as never,
            );

            const hash = await registry.initialize(SCHEMA_REGISTRY_ADDRESS);

            expect(hash).toBe(MOCK_TX_HASH);
            expect(walletClient.writeContract).toHaveBeenCalledOnce();
            expect(walletClient.writeContract).toHaveBeenCalledWith(
                expect.objectContaining({
                    address: CONTRACT_ADDRESS,
                    functionName: "initialize",
                    args: [SCHEMA_REGISTRY_ADDRESS],
                    account: walletClient.account,
                    chain: walletClient.chain,
                })
            );
        });

        it("waits for the transaction receipt", async () => {
            const { publicClient, walletClient } = makeClients();
            const registry = new DataSourceRegistry(
                CONTRACT_ADDRESS,
                publicClient as never,
                walletClient as never,
            );

            await registry.initialize(SCHEMA_REGISTRY_ADDRESS);

            expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({
                hash: MOCK_TX_HASH,
            });
        });

        it("throws if walletClient has no chain", async () => {
            const { publicClient, walletClient } = makeClients();
            (walletClient as never as { chain: null }).chain = null;

            const registry = new DataSourceRegistry(
                CONTRACT_ADDRESS,
                publicClient as never,
                walletClient as never,
            );

            await expect(registry.initialize(SCHEMA_REGISTRY_ADDRESS)).rejects.toThrow(
                "Chain required"
            );
        });

        it("throws if walletClient has no account", async () => {
            const { publicClient, walletClient } = makeClients();
            (walletClient as never as { account: null }).account = null;

            const registry = new DataSourceRegistry(
                CONTRACT_ADDRESS,
                publicClient as never,
                walletClient as never,
            );

            await expect(registry.initialize(SCHEMA_REGISTRY_ADDRESS)).rejects.toThrow(
                "Account required"
            );
        });
    });

    describe("publishManifest", () => {
        it("returns the tx hash on success", async () => {
            const { publicClient, walletClient } = makeClients();
            const registry = new DataSourceRegistry(
                CONTRACT_ADDRESS,
                publicClient as never,
                walletClient as never,
            );

            const hash = await registry.publishManifest(MOCK_MANIFEST_CID, MOCK_SCHEMA_ID);

            expect(hash).toBe(MOCK_TX_HASH);
        });

        it("calls writeContract with the correct args", async () => {
            const { publicClient, walletClient } = makeClients();
            const registry = new DataSourceRegistry(
                CONTRACT_ADDRESS,
                publicClient as never,
                walletClient as never,
            );

            await registry.publishManifest(MOCK_MANIFEST_CID, MOCK_SCHEMA_ID);

            expect(walletClient.writeContract).toHaveBeenCalledWith(
                expect.objectContaining({
                    address: CONTRACT_ADDRESS,
                    functionName: "publishManifest",
                    args: [MOCK_MANIFEST_CID, MOCK_SCHEMA_ID],
                })
            );
        });

        it("applies a 30% gas buffer on top of estimated gas", async () => {
            const estimatedGas = 100_000n;
            const { publicClient, walletClient } = makeClients({
                estimateContractGasImpl: () => estimatedGas,
            });
            const registry = new DataSourceRegistry(
                CONTRACT_ADDRESS,
                publicClient as never,
                walletClient as never,
            );

            await registry.publishManifest(MOCK_MANIFEST_CID, MOCK_SCHEMA_ID);

            expect(walletClient.writeContract).toHaveBeenCalledWith(
                expect.objectContaining({ gas: (estimatedGas * 130n) / 100n })
            );
        });

        it("uses the gas override when provided, skipping estimation", async () => {
            const { publicClient, walletClient } = makeClients();
            const registry = new DataSourceRegistry(
                CONTRACT_ADDRESS,
                publicClient as never,
                walletClient as never,
            );
            const overrideGas = 999_999n;

            await registry.publishManifest(MOCK_MANIFEST_CID, MOCK_SCHEMA_ID, overrideGas);

            expect(publicClient.estimateContractGas).not.toHaveBeenCalled();
            expect(walletClient.writeContract).toHaveBeenCalledWith(
                expect.objectContaining({ gas: overrideGas })
            );
        });

        it("triples maxFeePerGas from the fee estimate", async () => {
            const baseFee = 10n;
            const { publicClient, walletClient } = makeClients({
                estimateFeesPerGasImpl: () => ({
                    maxFeePerGas: baseFee,
                    maxPriorityFeePerGas: 2n,
                }),
            });
            const registry = new DataSourceRegistry(
                CONTRACT_ADDRESS,
                publicClient as never,
                walletClient as never,
            );

            await registry.publishManifest(MOCK_MANIFEST_CID, MOCK_SCHEMA_ID);

            expect(walletClient.writeContract).toHaveBeenCalledWith(
                expect.objectContaining({
                    maxFeePerGas: baseFee * 3n,
                    maxPriorityFeePerGas: 2n,
                })
            );
        });

        it("waits for the transaction receipt", async () => {
            const { publicClient, walletClient } = makeClients();
            const registry = new DataSourceRegistry(
                CONTRACT_ADDRESS,
                publicClient as never,
                walletClient as never,
            );

            await registry.publishManifest(MOCK_MANIFEST_CID, MOCK_SCHEMA_ID);

            expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({
                hash: MOCK_TX_HASH,
            });
        });
    });

    describe("getManifest", () => {
        it("returns manifestCid, schemaId, and version for a given owner", async () => {
            const mockVersion = 3n;

            const { publicClient, walletClient } = makeClients({
                readContractImpl: (args: unknown) => {
                    const { functionName } = args as { functionName: string };
                    if (functionName === "getManifest") return MOCK_MANIFEST_CID;
                    if (functionName === "getVersion") return mockVersion;
                },
            });

            const registry = new DataSourceRegistry(
                CONTRACT_ADDRESS,
                publicClient as never,
                walletClient as never,
            );

            const result = await registry.getManifest(OWNER_ADDRESS, MOCK_SCHEMA_ID);

            expect(result).toEqual({
                manifestCid: MOCK_MANIFEST_CID,
                schemaId: MOCK_SCHEMA_ID,
                version: mockVersion,
            });
        });

        it("issues both readContract calls in parallel", async () => {
            const callOrder: string[] = [];
            const { publicClient, walletClient } = makeClients({
                readContractImpl: (args: unknown) => {
                    const { functionName } = args as { functionName: string };
                    callOrder.push(functionName);
                    return functionName === "getManifest" ? MOCK_MANIFEST_CID : 1n;
                },
            });

            const registry = new DataSourceRegistry(
                CONTRACT_ADDRESS,
                publicClient as never,
                walletClient as never,
            );

            await registry.getManifest(OWNER_ADDRESS, MOCK_SCHEMA_ID);

            // Both calls must have been made (order not guaranteed since they're Promise.all'd)
            expect(callOrder).toContain("getManifest");
            expect(callOrder).toContain("getVersion");
            expect(publicClient.readContract).toHaveBeenCalledTimes(2);
        });
    });

    describe("getVersion", () => {
        it("returns the current version for an (owner, schemaId) pair", async () => {
            const { publicClient, walletClient } = makeClients({
                readContractImpl: () => 7n,
            });

            const registry = new DataSourceRegistry(
                CONTRACT_ADDRESS,
                publicClient as never,
                walletClient as never,
            );

            const version = await registry.getVersion(OWNER_ADDRESS, MOCK_SCHEMA_ID);

            expect(version).toBe(7n);
            expect(publicClient.readContract).toHaveBeenCalledWith(
                expect.objectContaining({
                    address: CONTRACT_ADDRESS,
                    functionName: "getVersion",
                    args: [OWNER_ADDRESS, MOCK_SCHEMA_ID],
                })
            );
        });
    });

    describe("waitForTransaction", () => {
        it("delegates to publicClient.waitForTransactionReceipt", async () => {
            const receipt = makeMockReceipt();
            const { publicClient, walletClient } = makeClients({
                waitForTransactionReceiptImpl: () => receipt,
            });

            const registry = new DataSourceRegistry(
                CONTRACT_ADDRESS,
                publicClient as never,
                walletClient as never,
            );

            const result = await registry.waitForTransaction(MOCK_TX_HASH);

            expect(result).toEqual(receipt);
            expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({
                hash: MOCK_TX_HASH,
            });
        });
    });
});