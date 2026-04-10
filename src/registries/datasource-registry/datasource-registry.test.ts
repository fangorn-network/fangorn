import { describe, it, expect, vi } from "vitest";
import { DataSourceRegistry } from "./index.js";
import { keccak256, encodePacked } from "viem";
import type { Address, Hash, Hex } from "viem";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CONTRACT_ADDRESS: Address         = "0x1111111111111111111111111111111111111111";
const SCHEMA_REGISTRY_ADDRESS: Address  = "0x2222222222222222222222222222222222222222";
const SETTLEMENT_REGISTRY_ADDRESS: Address = "0x4444444444444444444444444444444444444444";
const OWNER_ADDRESS: Address            = "0x3333333333333333333333333333333333333333";

const MOCK_SCHEMA_ID: Hex  = "0xdeadbeef00000000000000000000000000000000000000000000000000000000";
const MOCK_TX_HASH: Hash   = "0xaabbccdd00000000000000000000000000000000000000000000000000000000";
const MOCK_CID             = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const MOCK_NAME            = "track-1";
const MOCK_PRICE           = 1_000_000n;

// ── Mock factory ──────────────────────────────────────────────────────────────

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
    readContractImpl?: (args: unknown) => unknown;
    estimateContractGasImpl?: () => bigint;
    estimateFeesPerGasImpl?: () => { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
    writeContractImpl?: () => Hash;
    waitForTransactionReceiptImpl?: () => unknown;
} = {}) {
    const publicClient = {
        readContract: vi.fn(readContractImpl ?? (() => undefined)),
        estimateContractGas: vi.fn(estimateContractGasImpl ?? (() => 100_000n)),
        estimateFeesPerGas: vi.fn(
            estimateFeesPerGasImpl ?? (() => ({ maxFeePerGas: 10n, maxPriorityFeePerGas: 1n }))
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

function makeRegistry(clients = makeClients()) {
    return new DataSourceRegistry(
        CONTRACT_ADDRESS,
        clients.publicClient as never,
        clients.walletClient as never,
    );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("DataSourceRegistry", () => {

    describe("constructor / getContractAddress", () => {
        it("returns the address it was initialized with", () => {
            expect(makeRegistry().getContractAddress()).toBe(CONTRACT_ADDRESS);
        });
    });

    describe("publish", () => {
        it("returns the tx hash on success", async () => {
            const hash = await makeRegistry().publish(MOCK_CID, MOCK_SCHEMA_ID, MOCK_NAME, MOCK_PRICE);
            expect(hash).toBe(MOCK_TX_HASH);
        });

        it("calls writeContract with manifest_cid, schema_id, name, and price", async () => {
            const clients = makeClients();
            await makeRegistry(clients).publish(MOCK_CID, MOCK_SCHEMA_ID, MOCK_NAME, MOCK_PRICE);

            expect(clients.walletClient.writeContract).toHaveBeenCalledWith(
                expect.objectContaining({
                    address: CONTRACT_ADDRESS,
                    functionName: "publish",
                    args: [MOCK_CID, MOCK_SCHEMA_ID, MOCK_NAME, MOCK_PRICE],
                })
            );
        });

        it("applies a 30% gas buffer on top of the estimate", async () => {
            const estimated = 100_000n;
            const clients = makeClients({ estimateContractGasImpl: () => estimated });
            await makeRegistry(clients).publish(MOCK_CID, MOCK_SCHEMA_ID, MOCK_NAME, MOCK_PRICE);

            expect(clients.walletClient.writeContract).toHaveBeenCalledWith(
                expect.objectContaining({ gas: (estimated * 130n) / 100n })
            );
        });

        it("uses the gas override and skips estimation", async () => {
            const clients = makeClients();
            const override = 999_999n;
            await makeRegistry(clients).publish(MOCK_CID, MOCK_SCHEMA_ID, MOCK_NAME, MOCK_PRICE, override);

            expect(clients.publicClient.estimateContractGas).not.toHaveBeenCalled();
            expect(clients.walletClient.writeContract).toHaveBeenCalledWith(
                expect.objectContaining({ gas: override })
            );
        });

        it("triples maxFeePerGas from the fee estimate", async () => {
            const baseFee = 10n;
            const clients = makeClients({
                estimateFeesPerGasImpl: () => ({ maxFeePerGas: baseFee, maxPriorityFeePerGas: 2n }),
            });
            await makeRegistry(clients).publish(MOCK_CID, MOCK_SCHEMA_ID, MOCK_NAME, MOCK_PRICE);

            expect(clients.walletClient.writeContract).toHaveBeenCalledWith(
                expect.objectContaining({ maxFeePerGas: baseFee * 3n, maxPriorityFeePerGas: 2n })
            );
        });

        it("waits for the transaction receipt", async () => {
            const clients = makeClients();
            await makeRegistry(clients).publish(MOCK_CID, MOCK_SCHEMA_ID, MOCK_NAME, MOCK_PRICE);
            expect(clients.publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: MOCK_TX_HASH });
        });
    });

    describe("get", () => {
        it("returns manifestCid, name, schemaId, and version", async () => {
            const mockVersion = 3n;
            const clients = makeClients({
                readContractImpl: (args: unknown) => {
                    const { functionName } = args as { functionName: string };
                    if (functionName === "get") return MOCK_CID;
                    if (functionName === "getVersion") return mockVersion;
                },
            });

            const result = await makeRegistry(clients).get(OWNER_ADDRESS, MOCK_SCHEMA_ID, MOCK_NAME);

            expect(result).toEqual({
                manifestCid: MOCK_CID,
                name: MOCK_NAME,
                schemaId: MOCK_SCHEMA_ID,
                version: mockVersion,
            });
        });

        it("issues get and getVersion calls in parallel", async () => {
            const callOrder: string[] = [];
            const clients = makeClients({
                readContractImpl: (args: unknown) => {
                    const { functionName } = args as { functionName: string };
                    callOrder.push(functionName as string);
                    return functionName === "get" ? MOCK_CID : 1n;
                },
            });

            await makeRegistry(clients).get(OWNER_ADDRESS, MOCK_SCHEMA_ID, MOCK_NAME);

            expect(callOrder).toContain("get");
            expect(callOrder).toContain("getVersion");
            expect(clients.publicClient.readContract).toHaveBeenCalledTimes(2);
        });

        it("passes name through to both contract calls", async () => {
            const clients = makeClients({
                readContractImpl: (args: unknown) => {
                    const { functionName } = args as { functionName: string };
                    return functionName === "get" ? MOCK_CID : 1n;
                },
            });

            await makeRegistry(clients).get(OWNER_ADDRESS, MOCK_SCHEMA_ID, MOCK_NAME);

            expect(clients.publicClient.readContract).toHaveBeenCalledWith(
                expect.objectContaining({ functionName: "get", args: [OWNER_ADDRESS, MOCK_SCHEMA_ID, MOCK_NAME] })
            );
            expect(clients.publicClient.readContract).toHaveBeenCalledWith(
                expect.objectContaining({ functionName: "getVersion", args: [OWNER_ADDRESS, MOCK_SCHEMA_ID, MOCK_NAME] })
            );
        });
    });

    describe("getByHash", () => {
        it("calls getByHash with the name_hash and returns the CID", async () => {
            const nameHash: Hex = "0xabcd000000000000000000000000000000000000000000000000000000000000";
            const clients = makeClients({ readContractImpl: () => MOCK_CID });

            const result = await makeRegistry(clients).getByHash(OWNER_ADDRESS, MOCK_SCHEMA_ID, nameHash);

            expect(result).toBe(MOCK_CID);
            expect(clients.publicClient.readContract).toHaveBeenCalledWith(
                expect.objectContaining({
                    functionName: "getByHash",
                    args: [OWNER_ADDRESS, MOCK_SCHEMA_ID, nameHash],
                })
            );
        });
    });

    describe("getName", () => {
        it("calls getName with the name_hash and returns the original string", async () => {
            const nameHash: Hex = "0xabcd000000000000000000000000000000000000000000000000000000000000";
            const clients = makeClients({ readContractImpl: () => MOCK_NAME });

            const result = await makeRegistry(clients).getName(OWNER_ADDRESS, MOCK_SCHEMA_ID, nameHash);

            expect(result).toBe(MOCK_NAME);
            expect(clients.publicClient.readContract).toHaveBeenCalledWith(
                expect.objectContaining({
                    functionName: "getName",
                    args: [OWNER_ADDRESS, MOCK_SCHEMA_ID, nameHash],
                })
            );
        });
    });

    describe("getVersion", () => {
        it("calls getVersion with name and returns the current version", async () => {
            const clients = makeClients({ readContractImpl: () => 7n });

            const version = await makeRegistry(clients).getVersion(OWNER_ADDRESS, MOCK_SCHEMA_ID, MOCK_NAME);

            expect(version).toBe(7n);
            expect(clients.publicClient.readContract).toHaveBeenCalledWith(
                expect.objectContaining({
                    functionName: "getVersion",
                    args: [OWNER_ADDRESS, MOCK_SCHEMA_ID, MOCK_NAME],
                })
            );
        });
    });

    describe("resourceId", () => {
        it("calls the contract resourceId view and returns the result", async () => {
            const mockId: Hex = "0xbeef000000000000000000000000000000000000000000000000000000000000";
            const clients = makeClients({ readContractImpl: () => mockId });

            const result = await makeRegistry(clients).resourceId(OWNER_ADDRESS, MOCK_SCHEMA_ID, MOCK_NAME);

            expect(result).toBe(mockId);
            expect(clients.publicClient.readContract).toHaveBeenCalledWith(
                expect.objectContaining({
                    functionName: "resourceId",
                    args: [OWNER_ADDRESS, MOCK_SCHEMA_ID, MOCK_NAME],
                })
            );
        });
    });

    describe("resourceIdLocal", () => {
        it("matches the contract derivation: keccak256(owner ++ schema_id ++ keccak256(name))", () => {
            const registry = makeRegistry();
            const nameHash = keccak256(new TextEncoder().encode(MOCK_NAME) as Uint8Array<ArrayBuffer>);
            const expected = keccak256(
                encodePacked(
                    ["address", "bytes32", "bytes32"],
                    [OWNER_ADDRESS, MOCK_SCHEMA_ID, nameHash],
                )
            );

            expect(DataSourceRegistry.resourceIdLocal(OWNER_ADDRESS, MOCK_SCHEMA_ID, MOCK_NAME)).toBe(expected);
        });

        it("produces different ids for different names", () => {
            const registry = makeRegistry();
            const a = DataSourceRegistry.resourceIdLocal(OWNER_ADDRESS, MOCK_SCHEMA_ID, "track-1");
            const b = DataSourceRegistry.resourceIdLocal(OWNER_ADDRESS, MOCK_SCHEMA_ID, "track-2");
            expect(a).not.toBe(b);
        });

        it("produces different ids for different schemas", () => {
            const registry = makeRegistry();
            const schemaB: Hex = "0xbebebebe00000000000000000000000000000000000000000000000000000000";
            const a = DataSourceRegistry.resourceIdLocal(OWNER_ADDRESS, MOCK_SCHEMA_ID, MOCK_NAME);
            const b = DataSourceRegistry.resourceIdLocal(OWNER_ADDRESS, schemaB, MOCK_NAME);
            expect(a).not.toBe(b);
        });

        it("is deterministic", () => {
            const registry = makeRegistry();
            expect(DataSourceRegistry.resourceIdLocal(OWNER_ADDRESS, MOCK_SCHEMA_ID, MOCK_NAME))
                .toBe(DataSourceRegistry.resourceIdLocal(OWNER_ADDRESS, MOCK_SCHEMA_ID, MOCK_NAME));
        });

        it("makes no RPC calls", () => {
            const clients = makeClients();
            const registry = makeRegistry(clients);
            DataSourceRegistry.resourceIdLocal(OWNER_ADDRESS, MOCK_SCHEMA_ID, MOCK_NAME);
            expect(clients.publicClient.readContract).not.toHaveBeenCalled();
        });
    });

    describe("hashName", () => {
        it("produces the keccak256 of the UTF-8 encoded name", () => {
            const registry = makeRegistry();
            const expected = keccak256(new TextEncoder().encode(MOCK_NAME) as Uint8Array<ArrayBuffer>);
            expect(registry.hashName(MOCK_NAME)).toBe(expected);
        });

        it("is consistent with resourceIdLocal's internal hash", () => {
            const registry = makeRegistry();
            const nameHash = registry.hashName(MOCK_NAME);
            const fromLocal = DataSourceRegistry.resourceIdLocal(OWNER_ADDRESS, MOCK_SCHEMA_ID, MOCK_NAME);
            const manual = keccak256(
                encodePacked(["address", "bytes32", "bytes32"], [OWNER_ADDRESS, MOCK_SCHEMA_ID, nameHash])
            );
            expect(fromLocal).toBe(manual);
        });
    });

    describe("waitForTransaction", () => {
        it("delegates to publicClient.waitForTransactionReceipt", async () => {
            const receipt = makeMockReceipt();
            const clients = makeClients({ waitForTransactionReceiptImpl: () => receipt });
            const result = await makeRegistry(clients).waitForTransaction(MOCK_TX_HASH);
            expect(result).toEqual(receipt);
            expect(clients.publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: MOCK_TX_HASH });
        });
    });
});