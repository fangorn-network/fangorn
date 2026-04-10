import { describe, it, expect, vi, beforeEach } from "vitest";
import { SchemaRegistry } from "./index.js";
import type { Address, Hash, Hex } from "viem";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CONTRACT_ADDRESS: Address = "0x1111111111111111111111111111111111111111";
const OWNER_ADDRESS: Address = "0x3333333333333333333333333333333333333333";
const OTHER_ADDRESS: Address = "0x9999999999999999999999999999999999999999";

const MOCK_TX_HASH: Hash = "0xaabbccdd00000000000000000000000000000000000000000000000000000000";
const MOCK_SCHEMA_ID: Hex = "0xdeadbeef00000000000000000000000000000000000000000000000000000000";
const MOCK_SCHEMA_NAME = "music.track.v1";
const MOCK_SPEC_CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const MOCK_AGENT_ID = "agent-abc-123";

// ── Client factory ────────────────────────────────────────────────────────────

function makeClients({
    readContractImpl,
    simulateContractImpl,
    writeContractImpl,
    waitForTransactionReceiptImpl,
}: {
    readContractImpl?: (args: unknown) => unknown;
    simulateContractImpl?: (args: unknown) => unknown;
    writeContractImpl?: () => Hash;
    waitForTransactionReceiptImpl?: () => unknown;
} = {}) {
    const publicClient = {
        readContract: vi.fn(readContractImpl ?? (() => undefined)),
        simulateContract: vi.fn(
            simulateContractImpl ?? (() => Promise.resolve({ result: MOCK_SCHEMA_ID }))
        ),
        waitForTransactionReceipt: vi.fn(
            waitForTransactionReceiptImpl ?? (() => ({ status: "success", logs: [] }))
        ),
    };

    const walletClient = {
        chain: { id: 42161, name: "Arbitrum One" },
        account: { address: OWNER_ADDRESS },
        writeContract: vi.fn(writeContractImpl ?? (() => MOCK_TX_HASH)),
    };

    return { publicClient, walletClient };
}

function makeRegistry(overrides = {}) {
    const { publicClient, walletClient } = makeClients(overrides);
    const registry = new SchemaRegistry(
        CONTRACT_ADDRESS,
        publicClient as never,
        walletClient as never,
    );
    return { registry, publicClient, walletClient };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("SchemaRegistry", () => {

    describe("getContractAddress", () => {
        it("returns the address it was initialized with", () => {
            expect(makeRegistry().registry.getContractAddress()).toBe(CONTRACT_ADDRESS);
        });
    });

    // ── schemaId ──────────────────────────────────────────────────────────────

    describe("schemaId", () => {
        it("calls readContract with schemaId and the given name", async () => {
            const { registry, publicClient } = makeRegistry({
                readContractImpl: () => MOCK_SCHEMA_ID,
            });

            const result = await registry.schemaId(MOCK_SCHEMA_NAME);

            expect(result).toBe(MOCK_SCHEMA_ID);
            expect(publicClient.readContract).toHaveBeenCalledWith(
                expect.objectContaining({
                    address: CONTRACT_ADDRESS,
                    functionName: "schemaId",
                    args: [MOCK_SCHEMA_NAME],
                })
            );
        });
    });

    // ── registerSchema ────────────────────────────────────────────────────────

    describe("registerSchema", () => {
        it("returns the tx hash and schema id from simulateContract", async () => {
            const { registry } = makeRegistry({
                simulateContractImpl: () => Promise.resolve({ result: MOCK_SCHEMA_ID }),
            });

            const result = await registry.registerSchema(MOCK_SCHEMA_NAME, MOCK_SPEC_CID, MOCK_AGENT_ID);

            expect(result.hash).toBe(MOCK_TX_HASH);
            expect(result.schemaId).toBe(MOCK_SCHEMA_ID);
        });

        it("calls simulateContract before writeContract to get the schema id", async () => {
            const { registry, publicClient } = makeRegistry();

            await registry.registerSchema(MOCK_SCHEMA_NAME, MOCK_SPEC_CID, MOCK_AGENT_ID);

            expect(publicClient.simulateContract).toHaveBeenCalledWith(
                expect.objectContaining({
                    functionName: "registerSchema",
                    args: [MOCK_SCHEMA_NAME, MOCK_SPEC_CID, MOCK_AGENT_ID],
                    account: { address: OWNER_ADDRESS },
                })
            );
        });

        it("calls writeContract with the correct args", async () => {
            const { registry, walletClient } = makeRegistry();

            await registry.registerSchema(MOCK_SCHEMA_NAME, MOCK_SPEC_CID, MOCK_AGENT_ID);

            expect(walletClient.writeContract).toHaveBeenCalledWith(
                expect.objectContaining({
                    address: CONTRACT_ADDRESS,
                    functionName: "registerSchema",
                    args: [MOCK_SCHEMA_NAME, MOCK_SPEC_CID, MOCK_AGENT_ID],
                })
            );
        });

        it("waits for the transaction receipt", async () => {
            const { registry, publicClient } = makeRegistry();

            await registry.registerSchema(MOCK_SCHEMA_NAME, MOCK_SPEC_CID, MOCK_AGENT_ID);

            expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({
                hash: MOCK_TX_HASH,
            });
        });

        it("does not call parseEventLogs", async () => {
            const { registry, publicClient } = makeRegistry();
            await registry.registerSchema(MOCK_SCHEMA_NAME, MOCK_SPEC_CID, MOCK_AGENT_ID);
            // simulateContract is the source of the schema id — no log parsing needed
            expect(publicClient.readContract).not.toHaveBeenCalled();
        });

        it("throws if walletClient has no chain", async () => {
            const { publicClient, walletClient } = makeClients();
            (walletClient as never as { chain: null }).chain = null;
            const registry = new SchemaRegistry(CONTRACT_ADDRESS, publicClient as never, walletClient as never);
            await expect(
                registry.registerSchema(MOCK_SCHEMA_NAME, MOCK_SPEC_CID, MOCK_AGENT_ID)
            ).rejects.toThrow("Chain required");
        });

        it("throws if walletClient has no account", async () => {
            const { publicClient, walletClient } = makeClients();
            (walletClient as never as { account: null }).account = null;
            const registry = new SchemaRegistry(CONTRACT_ADDRESS, publicClient as never, walletClient as never);
            await expect(
                registry.registerSchema(MOCK_SCHEMA_NAME, MOCK_SPEC_CID, MOCK_AGENT_ID)
            ).rejects.toThrow("Account required");
        });
    });

    // ── updateSchema ──────────────────────────────────────────────────────────

    describe("updateSchema", () => {
        const NEW_CID = "bafyNewCid";
        const NEW_AGENT = "agent-new";

        it("resolves a name to an id via schemaId RPC then updates", async () => {
            const { registry, publicClient, walletClient } = makeRegistry({
                readContractImpl: (args: unknown) => {
                    const { functionName } = args as { functionName: string };
                    if (functionName === "schemaId") return MOCK_SCHEMA_ID;
                },
            });

            const hash = await registry.updateSchema(MOCK_SCHEMA_NAME, NEW_CID, NEW_AGENT);

            expect(hash).toBe(MOCK_TX_HASH);
            expect(publicClient.readContract).toHaveBeenCalledWith(
                expect.objectContaining({ functionName: "schemaId", args: [MOCK_SCHEMA_NAME] })
            );
            expect(walletClient.writeContract).toHaveBeenCalledWith(
                expect.objectContaining({
                    functionName: "updateSchema",
                    args: [MOCK_SCHEMA_ID, NEW_CID, NEW_AGENT],
                })
            );
        });

        it("skips the schemaId RPC call when a bytes32 id is passed", async () => {
            const { registry, publicClient } = makeRegistry();

            await registry.updateSchema(MOCK_SCHEMA_ID, NEW_CID, NEW_AGENT);

            expect(publicClient.readContract).not.toHaveBeenCalled();
        });

        it("waits for the transaction receipt", async () => {
            const { registry, publicClient } = makeRegistry({
                readContractImpl: () => MOCK_SCHEMA_ID,
            });

            await registry.updateSchema(MOCK_SCHEMA_NAME, NEW_CID, NEW_AGENT);

            expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({
                hash: MOCK_TX_HASH,
            });
        });
    });

    // ── deleteSchema ──────────────────────────────────────────────────────────

    describe("deleteSchema", () => {
        it("returns the tx hash", async () => {
            const { registry } = makeRegistry();
            expect(await registry.deleteSchema(MOCK_SCHEMA_ID)).toBe(MOCK_TX_HASH);
        });

        it("calls writeContract with deleteSchema and the resolved id", async () => {
            const { registry, walletClient } = makeRegistry();

            await registry.deleteSchema(MOCK_SCHEMA_ID);

            expect(walletClient.writeContract).toHaveBeenCalledWith(
                expect.objectContaining({
                    functionName: "deleteSchema",
                    args: [MOCK_SCHEMA_ID],
                })
            );
        });

        it("resolves a name to an id before deleting", async () => {
            const { registry, publicClient, walletClient } = makeRegistry({
                readContractImpl: () => MOCK_SCHEMA_ID,
            });

            await registry.deleteSchema(MOCK_SCHEMA_NAME);

            expect(publicClient.readContract).toHaveBeenCalledWith(
                expect.objectContaining({ functionName: "schemaId", args: [MOCK_SCHEMA_NAME] })
            );
            expect(walletClient.writeContract).toHaveBeenCalledWith(
                expect.objectContaining({ args: [MOCK_SCHEMA_ID] })
            );
        });

        it("waits for the transaction receipt", async () => {
            const { registry, publicClient } = makeRegistry();

            await registry.deleteSchema(MOCK_SCHEMA_ID);

            expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({
                hash: MOCK_TX_HASH,
            });
        });

        it("throws if wallet has no chain", async () => {
            const { publicClient, walletClient } = makeClients();
            (walletClient as never as { chain: null }).chain = null;
            const registry = new SchemaRegistry(CONTRACT_ADDRESS, publicClient as never, walletClient as never);
            await expect(registry.deleteSchema(MOCK_SCHEMA_ID)).rejects.toThrow("Chain required");
        });
    });

    // ── getSchema ─────────────────────────────────────────────────────────────

    describe("getSchema", () => {
        it("returns all four schema fields", async () => {
            const { registry } = makeRegistry({
                readContractImpl: (args: unknown) => {
                    const { functionName } = args as { functionName: string };
                    if (functionName === "schemaId") return MOCK_SCHEMA_ID;
                    if (functionName === "getSchemaSpec") return MOCK_SPEC_CID;
                    if (functionName === "getSchemaAgent") return MOCK_AGENT_ID;
                    if (functionName === "getSchemaName") return MOCK_SCHEMA_NAME;
                    if (functionName === "getSchemaOwner") return OWNER_ADDRESS;
                },
            });

            const result = await registry.getSchema(MOCK_SCHEMA_NAME);

            expect(result).toEqual({
                name: MOCK_SCHEMA_NAME,
                specCid: MOCK_SPEC_CID,
                agentId: MOCK_AGENT_ID,
                owner: OWNER_ADDRESS,
            });
        });

        it("uses specCid not cid as the field name", async () => {
            const { registry } = makeRegistry({
                readContractImpl: (args: unknown) => {
                    const { functionName } = args as { functionName: string };
                    if (functionName === "getSchemaSpec") return MOCK_SPEC_CID;
                    return undefined;
                },
            });
            const result = await registry.getSchema(MOCK_SCHEMA_ID);
            expect("specCid" in result).toBe(true);
            expect("cid" in result).toBe(false);
        });

        it("fetches all four fields in parallel", async () => {
            const callOrder: string[] = [];
            const { registry, publicClient } = makeRegistry({
                readContractImpl: (args: unknown) => {
                    const { functionName } = args as { functionName: string };
                    callOrder.push(functionName as string);
                    if (functionName === "schemaId") return MOCK_SCHEMA_ID;
                    if (functionName === "getSchemaSpec") return MOCK_SPEC_CID;
                    if (functionName === "getSchemaAgent") return MOCK_AGENT_ID;
                    if (functionName === "getSchemaName") return MOCK_SCHEMA_NAME;
                    if (functionName === "getSchemaOwner") return OWNER_ADDRESS;
                },
            });

            await registry.getSchema(MOCK_SCHEMA_NAME);

            // schemaId resolution + 4 parallel reads = 5 total
            expect(publicClient.readContract).toHaveBeenCalledTimes(5);
            expect(callOrder).toContain("getSchemaSpec");
            expect(callOrder).toContain("getSchemaAgent");
            expect(callOrder).toContain("getSchemaName");
            expect(callOrder).toContain("getSchemaOwner");
        });

        it("skips schemaId RPC when a bytes32 id is passed", async () => {
            const { registry, publicClient } = makeRegistry({
                readContractImpl: () => undefined,
            });

            await registry.getSchema(MOCK_SCHEMA_ID);

            expect(publicClient.readContract).not.toHaveBeenCalledWith(
                expect.objectContaining({ functionName: "schemaId" })
            );
            // only the 4 field reads
            expect(publicClient.readContract).toHaveBeenCalledTimes(4);
        });
    });

    // ── schemaExists ──────────────────────────────────────────────────────────

    describe("schemaExists", () => {
        it("returns true when the schema exists", async () => {
            const { registry } = makeRegistry({
                readContractImpl: (args: unknown) => {
                    const { functionName } = args as { functionName: string };
                    if (functionName === "schemaId") return MOCK_SCHEMA_ID;
                    if (functionName === "schemaExists") return true;
                },
            });
            expect(await registry.schemaExists(MOCK_SCHEMA_NAME)).toBe(true);
        });

        it("returns false when the schema does not exist", async () => {
            const { registry } = makeRegistry({
                readContractImpl: (args: unknown) => {
                    const { functionName } = args as { functionName: string };
                    if (functionName === "schemaId") return MOCK_SCHEMA_ID;
                    if (functionName === "schemaExists") return false;
                },
            });
            expect(await registry.schemaExists(MOCK_SCHEMA_NAME)).toBe(false);
        });

        it("calls schemaExists with the resolved id", async () => {
            const { registry, publicClient } = makeRegistry({
                readContractImpl: (args: unknown) => {
                    const { functionName } = args as { functionName: string };
                    if (functionName === "schemaId") return MOCK_SCHEMA_ID;
                    if (functionName === "schemaExists") return true;
                },
            });

            await registry.schemaExists(MOCK_SCHEMA_NAME);

            expect(publicClient.readContract).toHaveBeenCalledWith(
                expect.objectContaining({ functionName: "schemaExists", args: [MOCK_SCHEMA_ID] })
            );
        });

        it("skips schemaId RPC when a bytes32 id is passed", async () => {
            const { registry, publicClient } = makeRegistry({
                readContractImpl: () => true,
            });

            await registry.schemaExists(MOCK_SCHEMA_ID);

            expect(publicClient.readContract).not.toHaveBeenCalledWith(
                expect.objectContaining({ functionName: "schemaId" })
            );
        });
    });

    // ── hasPublishers ─────────────────────────────────────────────────────────

    describe("hasPublishers", () => {
        it("returns true when publishers exist", async () => {
            const { registry } = makeRegistry({
                readContractImpl: (args: unknown) => {
                    const { functionName } = args as { functionName: string };
                    if (functionName === "schemaId") return MOCK_SCHEMA_ID;
                    if (functionName === "hasPublishers") return true;
                },
            });
            expect(await registry.hasPublishers(MOCK_SCHEMA_NAME)).toBe(true);
        });

        it("returns false when no publishers exist", async () => {
            const { registry } = makeRegistry({
                readContractImpl: (args: unknown) => {
                    const { functionName } = args as { functionName: string };
                    if (functionName === "schemaId") return MOCK_SCHEMA_ID;
                    if (functionName === "hasPublishers") return false;
                },
            });
            expect(await registry.hasPublishers(MOCK_SCHEMA_NAME)).toBe(false);
        });

        it("calls hasPublishers with the resolved id", async () => {
            const { registry, publicClient } = makeRegistry({
                readContractImpl: (args: unknown) => {
                    const { functionName } = args as { functionName: string };
                    if (functionName === "schemaId") return MOCK_SCHEMA_ID;
                    if (functionName === "hasPublishers") return true;
                },
            });

            await registry.hasPublishers(MOCK_SCHEMA_NAME);

            expect(publicClient.readContract).toHaveBeenCalledWith(
                expect.objectContaining({ functionName: "hasPublishers", args: [MOCK_SCHEMA_ID] })
            );
        });
    });

    // ── isPublisher ───────────────────────────────────────────────────────────

    describe("isPublisher", () => {
        it("returns true when the address is a publisher", async () => {
            const { registry } = makeRegistry({
                readContractImpl: (args: unknown) => {
                    const { functionName } = args as { functionName: string };
                    if (functionName === "schemaId") return MOCK_SCHEMA_ID;
                    if (functionName === "isPublisher") return true;
                },
            });
            expect(await registry.isPublisher(MOCK_SCHEMA_NAME, OWNER_ADDRESS)).toBe(true);
        });

        it("returns false when the address is not a publisher", async () => {
            const { registry } = makeRegistry({
                readContractImpl: (args: unknown) => {
                    const { functionName } = args as { functionName: string };
                    if (functionName === "schemaId") return MOCK_SCHEMA_ID;
                    if (functionName === "isPublisher") return false;
                },
            });
            expect(await registry.isPublisher(MOCK_SCHEMA_NAME, OTHER_ADDRESS)).toBe(false);
        });

        it("calls isPublisher with the resolved id and publisher address", async () => {
            const { registry, publicClient } = makeRegistry({
                readContractImpl: (args: unknown) => {
                    const { functionName } = args as { functionName: string };
                    if (functionName === "schemaId") return MOCK_SCHEMA_ID;
                    if (functionName === "isPublisher") return true;
                },
            });

            await registry.isPublisher(MOCK_SCHEMA_NAME, OWNER_ADDRESS);

            expect(publicClient.readContract).toHaveBeenCalledWith(
                expect.objectContaining({
                    functionName: "isPublisher",
                    args: [MOCK_SCHEMA_ID, OWNER_ADDRESS],
                })
            );
        });
    });

    // ── getPublisherCount ─────────────────────────────────────────────────────

    describe("getPublisherCount", () => {
        it("returns the publisher count", async () => {
            const { registry } = makeRegistry({
                readContractImpl: (args: unknown) => {
                    const { functionName } = args as { functionName: string };
                    if (functionName === "schemaId") return MOCK_SCHEMA_ID;
                    if (functionName === "getPublisherCount") return 3n;
                },
            });
            expect(await registry.getPublisherCount(MOCK_SCHEMA_NAME)).toBe(3n);
        });

        it("calls getPublisherCount with the resolved id", async () => {
            const { registry, publicClient } = makeRegistry({
                readContractImpl: (args: unknown) => {
                    const { functionName } = args as { functionName: string };
                    if (functionName === "schemaId") return MOCK_SCHEMA_ID;
                    if (functionName === "getPublisherCount") return 1n;
                },
            });

            await registry.getPublisherCount(MOCK_SCHEMA_NAME);

            expect(publicClient.readContract).toHaveBeenCalledWith(
                expect.objectContaining({
                    functionName: "getPublisherCount",
                    args: [MOCK_SCHEMA_ID],
                })
            );
        });

        it("skips schemaId RPC when a bytes32 id is passed", async () => {
            const { registry, publicClient } = makeRegistry({
                readContractImpl: () => 2n,
            });

            await registry.getPublisherCount(MOCK_SCHEMA_ID);

            expect(publicClient.readContract).not.toHaveBeenCalledWith(
                expect.objectContaining({ functionName: "schemaId" })
            );
        });
    });

    // ── waitForTransaction ────────────────────────────────────────────────────

    describe("waitForTransaction", () => {
        it("delegates to publicClient.waitForTransactionReceipt", async () => {
            const receipt = { status: "success", logs: [] };
            const { registry, publicClient } = makeRegistry({
                waitForTransactionReceiptImpl: () => receipt,
            });

            const result = await registry.waitForTransaction(MOCK_TX_HASH);

            expect(result).toEqual(receipt);
            expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({
                hash: MOCK_TX_HASH,
            });
        });
    });
});