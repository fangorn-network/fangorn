import { describe, it, expect, vi } from "vitest";
import { SchemaRegistry } from "./index.js";
import type { Address, Hash, Hex } from "viem";

// --- Fixtures ---

const CONTRACT_ADDRESS: Address = "0x1111111111111111111111111111111111111111";
const OWNER_ADDRESS: Address = "0x3333333333333333333333333333333333333333";

const MOCK_TX_HASH: Hash = "0xaabbccdd00000000000000000000000000000000000000000000000000000000";
const MOCK_SCHEMA_ID: Hex = "0xdeadbeef00000000000000000000000000000000000000000000000000000000";
const MOCK_SCHEMA_NAME = "music.track.v1";
const MOCK_SPEC_CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const MOCK_AGENT_ID = "agent-abc-123";

// A receipt whose logs contain a SchemaRegistered event with our mock schema id.
// parseEventLogs is called against this, so the shape must match viem's expectations.
function makeMockReceipt(schemaId: Hex = MOCK_SCHEMA_ID) {
    return {
        logs: [
            {
                // viem's parseEventLogs uses the topics/data fields from the raw log.
                // Since we mock parseEventLogs via vi.mock below, we only need the
                // receipt to be passable — the shape here doesn't matter.
                address: CONTRACT_ADDRESS,
                topics: [],
                data: "0x",
                schemaId, // carried for reference in tests
            },
        ],
    };
}

// --- vi.mock for viem's parseEventLogs ---
// SchemaRegistry calls parseEventLogs internally, so we mock it at the module level.

vi.mock("viem", async (importOriginal) => {
    const actual = await importOriginal<typeof import("viem")>();
    return {
        ...actual,
        parseEventLogs: vi.fn(() => [
            { eventName: "SchemaRegistered", args: { id: MOCK_SCHEMA_ID } },
        ]),
    };
});

// --- Client factory ---

function makeClients({
    readContractImpl,
    writeContractImpl,
    waitForTransactionReceiptImpl,
}: {
    readContractImpl?: (args: unknown) => unknown;
    writeContractImpl?: () => Hash;
    waitForTransactionReceiptImpl?: () => unknown;
} = {}) {
    const publicClient = {
        readContract: vi.fn(readContractImpl ?? (() => undefined)),
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

function makeRegistry(overrides = {}) {
    const { publicClient, walletClient } = makeClients(overrides);
    const registry = new SchemaRegistry(
        CONTRACT_ADDRESS,
        publicClient as never,
        walletClient as never,
    );
    return { registry, publicClient, walletClient };
}

// --- Tests ---

describe("SchemaRegistry", () => {
    describe("getContractAddress", () => {
        it("returns the address it was initialized with", () => {
            const { registry } = makeRegistry();
            expect(registry.getContractAddress()).toBe(CONTRACT_ADDRESS);
        });
    });

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

    describe("registerSchema", () => {
        it("returns the tx hash and schema id from the event log", async () => {
            const { registry } = makeRegistry();

            const result = await registry.registerSchema(
                MOCK_SCHEMA_NAME,
                MOCK_SPEC_CID,
                MOCK_AGENT_ID,
            );

            expect(result.hash).toBe(MOCK_TX_HASH);
            expect(result.schemaId).toBe(MOCK_SCHEMA_ID);
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

        it("throws if walletClient has no chain", async () => {
            const { publicClient, walletClient } = makeClients();
            (walletClient as never as { chain: null }).chain = null;
            const registry = new SchemaRegistry(
                CONTRACT_ADDRESS,
                publicClient as never,
                walletClient as never,
            );

            await expect(
                registry.registerSchema(MOCK_SCHEMA_NAME, MOCK_SPEC_CID, MOCK_AGENT_ID)
            ).rejects.toThrow("Chain required");
        });

        it("throws if walletClient has no account", async () => {
            const { publicClient, walletClient } = makeClients();
            (walletClient as never as { account: null }).account = null;
            const registry = new SchemaRegistry(
                CONTRACT_ADDRESS,
                publicClient as never,
                walletClient as never,
            );

            await expect(
                registry.registerSchema(MOCK_SCHEMA_NAME, MOCK_SPEC_CID, MOCK_AGENT_ID)
            ).rejects.toThrow("Account required");
        });
    });

    describe("updateSchema", () => {
        const NEW_CID = "bafyNewCid";
        const NEW_AGENT = "agent-new";

        it("resolves a name to an id via schemaId RPC call, then updates", async () => {
            const { registry, publicClient, walletClient } = makeRegistry({
                readContractImpl: (args: unknown) => {
                    const { functionName } = args as { functionName: string };
                    if (functionName === "schemaId") return MOCK_SCHEMA_ID;
                },
            });

            const hash = await registry.updateSchema(MOCK_SCHEMA_NAME, NEW_CID, NEW_AGENT);

            expect(hash).toBe(MOCK_TX_HASH);
            // schemaId RPC was needed since we passed a name, not a bytes32
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

        it("skips the schemaId RPC call when a bytes32 id is passed directly", async () => {
            const { registry, publicClient } = makeRegistry();

            await registry.updateSchema(MOCK_SCHEMA_ID, NEW_CID, NEW_AGENT);

            expect(publicClient.readContract).not.toHaveBeenCalled();
        });

        it("passes the resolved id to writeContract", async () => {
            const { registry, walletClient } = makeRegistry({
                readContractImpl: () => MOCK_SCHEMA_ID,
            });

            await registry.updateSchema(MOCK_SCHEMA_NAME, NEW_CID, NEW_AGENT);

            expect(walletClient.writeContract).toHaveBeenCalledWith(
                expect.objectContaining({
                    functionName: "updateSchema",
                    args: [MOCK_SCHEMA_ID, NEW_CID, NEW_AGENT],
                })
            );
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

    describe("getSchema", () => {
        it("returns the schema fields for a given name", async () => {
            const { registry } = makeRegistry({
                readContractImpl: (args: unknown) => {
                    const { functionName } = args as { functionName: string };
                    if (functionName === "schemaId") return MOCK_SCHEMA_ID;
                    if (functionName === "getSchemaSpec") return MOCK_SPEC_CID;
                    if (functionName === "getSchemaAgent") return MOCK_AGENT_ID;
                },
            });

            const result = await registry.getSchema(MOCK_SCHEMA_NAME);

            expect(result).toEqual({
                name: MOCK_SCHEMA_NAME,
                cid: MOCK_SPEC_CID,
                agentId: MOCK_AGENT_ID,
            });
        });

        it("uses the raw id as the name field when a bytes32 id is passed", async () => {
            const { registry } = makeRegistry({
                readContractImpl: (args: unknown) => {
                    const { functionName } = args as { functionName: string };
                    if (functionName === "getSchemaSpec") return MOCK_SPEC_CID;
                    if (functionName === "getSchemaAgent") return MOCK_AGENT_ID;
                },
            });

            const result = await registry.getSchema(MOCK_SCHEMA_ID);

            expect(result.name).toBe(MOCK_SCHEMA_ID);
        });

        it("fetches spec and agent in parallel", async () => {
            const callOrder: string[] = [];
            const { registry, publicClient } = makeRegistry({
                readContractImpl: (args: unknown) => {
                    const { functionName } = args as { functionName: string };
                    callOrder.push(functionName);
                    if (functionName === "schemaId") return MOCK_SCHEMA_ID;
                    if (functionName === "getSchemaSpec") return MOCK_SPEC_CID;
                    if (functionName === "getSchemaAgent") return MOCK_AGENT_ID;
                },
            });

            await registry.getSchema(MOCK_SCHEMA_NAME);

            expect(callOrder).toContain("getSchemaSpec");
            expect(callOrder).toContain("getSchemaAgent");
            // schemaId + getSchemaSpec + getSchemaAgent = 3 calls total
            expect(publicClient.readContract).toHaveBeenCalledTimes(3);
        });

        it("skips the schemaId RPC call when a bytes32 id is passed", async () => {
            const { registry, publicClient } = makeRegistry({
                readContractImpl: (args: unknown) => {
                    const { functionName } = args as { functionName: string };
                    if (functionName === "getSchemaSpec") return MOCK_SPEC_CID;
                    if (functionName === "getSchemaAgent") return MOCK_AGENT_ID;
                },
            });

            await registry.getSchema(MOCK_SCHEMA_ID);

            expect(publicClient.readContract).not.toHaveBeenCalledWith(
                expect.objectContaining({ functionName: "schemaId" })
            );
        });
    });

    describe("schemaExists", () => {
        it("returns true when the contract reports the schema exists", async () => {
            const { registry } = makeRegistry({
                readContractImpl: (args: unknown) => {
                    const { functionName } = args as { functionName: string };
                    if (functionName === "schemaId") return MOCK_SCHEMA_ID;
                    if (functionName === "schemaExists") return true;
                },
            });

            const exists = await registry.schemaExists(MOCK_SCHEMA_NAME);
            expect(exists).toBe(true);
        });

        it("returns false when the contract reports the schema does not exist", async () => {
            const { registry } = makeRegistry({
                readContractImpl: (args: unknown) => {
                    const { functionName } = args as { functionName: string };
                    if (functionName === "schemaId") return MOCK_SCHEMA_ID;
                    if (functionName === "schemaExists") return false;
                },
            });

            const exists = await registry.schemaExists(MOCK_SCHEMA_NAME);
            expect(exists).toBe(false);
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
                expect.objectContaining({
                    functionName: "schemaExists",
                    args: [MOCK_SCHEMA_ID],
                })
            );
        });

        it("skips the schemaId RPC call when a bytes32 id is passed", async () => {
            const { registry, publicClient } = makeRegistry({
                readContractImpl: (args: unknown) => {
                    const { functionName } = args as { functionName: string };
                    if (functionName === "schemaExists") return true;
                },
            });

            await registry.schemaExists(MOCK_SCHEMA_ID);

            expect(publicClient.readContract).not.toHaveBeenCalledWith(
                expect.objectContaining({ functionName: "schemaId" })
            );
        });
    });

    describe("waitForTransaction", () => {
        it("delegates to publicClient.waitForTransactionReceipt", async () => {
            const receipt = makeMockReceipt();
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