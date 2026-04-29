import { describe, it, expect, vi, beforeEach } from "vitest";
import { SettlementRegistry } from "./index.js";
import type { Address, Hex } from "viem";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONTRACT_ADDRESS: Address = "0x1111111111111111111111111111111111111111";
const OWNER_ADDRESS: Address = "0x3333333333333333333333333333333333333333";
const OTHER_ADDRESS: Address = "0x9999999999999999999999999999999999999999";
const STEALTH_ADDRESS: Address = "0x4444444444444444444444444444444444444444";
const PAYMENT_RECIPIENT: Address = "0x5555555555555555555555555555555555555555";
const USDC_ADDRESS: Address = "0x6666666666666666666666666666666666666666";
const HOOK_ADDRESS: Address = "0x7777777777777777777777777777777777777777";
const REGISTRY_ADDRESS: Address = "0x8888888888888888888888888888888888888888";

const MOCK_TX_HASH: Hex = "0xaabbccdd00000000000000000000000000000000000000000000000000000000";
const MOCK_RESOURCE_ID: Hex = "0xdeadbeef00000000000000000000000000000000000000000000000000000000";
const MOCK_RELAYER_KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const MOCK_GROUP_ID = 42n;
const MOCK_IDENTITY_COMMITMENT = 12345678901234567890n;
const MOCK_PRICE = 1_000_000n;

const MOCK_PROOF = {
    merkleTreeDepth: 20,
    merkleTreeRoot: "111",
    nullifier: "222",
    message: "333",
    points: ["1", "2", "3", "4", "5", "6", "7", "8"],
};

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("@semaphore-protocol/proof", () => ({
    generateProof: vi.fn(() => MOCK_PROOF),
}));

vi.mock("@semaphore-protocol/group", () => {
    class Group {
        addMember() { /* mock */ }
    }
    return { Group };
});

vi.mock("viem/accounts", () => ({
    privateKeyToAccount: vi.fn((key: Hex) => ({ address: OWNER_ADDRESS, key })),
}));

const mockRelayerWriteContract = vi.fn(() => MOCK_TX_HASH);

vi.mock("viem", async (importOriginal) => {
    const actual = await importOriginal<typeof import("viem")>();
    return {
        ...actual,
        parseSignature: vi.fn(() => ({
            v: 28n,
            r: ("0x" + "aa".repeat(32)) as Hex,
            s: ("0x" + "bb".repeat(32)) as Hex,
        })),
        createWalletClient: vi.fn(() => ({
            writeContract: mockRelayerWriteContract,
        })),
    };
});

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

function makeClients({
    readContractImpl,
    writeContractImpl,
    waitForTransactionReceiptImpl,
    getLogsImpl,
    signTypedDataImpl,
}: {
    readContractImpl?: (args: unknown) => unknown;
    writeContractImpl?: () => Hex;
    waitForTransactionReceiptImpl?: () => unknown;
    getLogsImpl?: () => unknown[];
    signTypedDataImpl?: () => Hex;
} = {}) {
    const publicClient = {
        readContract: vi.fn(readContractImpl ?? (() => undefined)),
        waitForTransactionReceipt: vi.fn(
            waitForTransactionReceiptImpl ?? (() => ({ status: "success", logs: [] }))
        ),
        getLogs: vi.fn(getLogsImpl ?? (() => [])),
    };

    const walletClient = {
        chain: { id: 421614, name: "Arbitrum Sepolia", rpcUrls: { default: { http: ["https://rpc.example.com"] } } },
        account: { address: OWNER_ADDRESS },
        writeContract: vi.fn(writeContractImpl ?? (() => MOCK_TX_HASH)),
        signTypedData: vi.fn(signTypedDataImpl ?? (() => "0xMOCKSIG")),
    };

    return { publicClient, walletClient };
}

function makeRegistry(overrides = {}) {
    const { publicClient, walletClient } = makeClients(overrides);
    const registry = new SettlementRegistry(
        CONTRACT_ADDRESS,
        publicClient as never,
        walletClient as never,
    );
    return { registry, publicClient, walletClient };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SettlementRegistry", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockRelayerWriteContract.mockResolvedValue(MOCK_TX_HASH);
    });

    // -------------------------------------------------------------------------
    describe("setRegistry", () => {
        it("returns the tx hash when authorizing", async () => {
            const { registry } = makeRegistry();
            expect(await registry.setRegistry(REGISTRY_ADDRESS, true)).toBe(MOCK_TX_HASH);
        });

        it("returns the tx hash when revoking", async () => {
            const { registry } = makeRegistry();
            expect(await registry.setRegistry(REGISTRY_ADDRESS, false)).toBe(MOCK_TX_HASH);
        });

        it("calls writeContract with registry and authorized flag", async () => {
            const { registry, walletClient } = makeRegistry();
            await registry.setRegistry(REGISTRY_ADDRESS, true);
            expect(walletClient.writeContract).toHaveBeenCalledWith(
                expect.objectContaining({
                    address: CONTRACT_ADDRESS,
                    functionName: "setRegistry",
                    args: [REGISTRY_ADDRESS, true],
                })
            );
        });

        it("waits for the receipt", async () => {
            const { registry, publicClient } = makeRegistry();
            await registry.setRegistry(REGISTRY_ADDRESS, true);
            expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: MOCK_TX_HASH });
        });

        it("throws if wallet has no account", async () => {
            const { publicClient, walletClient } = makeClients();
            (walletClient as never as { account: null }).account = null;
            const registry = new SettlementRegistry(CONTRACT_ADDRESS, publicClient as never, walletClient as never);
            await expect(registry.setRegistry(REGISTRY_ADDRESS, true)).rejects.toThrow("must have an account");
        });
    });

    // -------------------------------------------------------------------------
    describe("createResource", () => {
        it("returns the tx hash", async () => {
            const { registry } = makeRegistry();
            expect(await registry.createResource(MOCK_RESOURCE_ID, MOCK_PRICE, OWNER_ADDRESS)).toBe(MOCK_TX_HASH);
        });

        it("calls writeContract with resource_id, price, and owner", async () => {
            const { registry, walletClient } = makeRegistry();
            await registry.createResource(MOCK_RESOURCE_ID, MOCK_PRICE, OWNER_ADDRESS);
            expect(walletClient.writeContract).toHaveBeenCalledWith(
                expect.objectContaining({
                    address: CONTRACT_ADDRESS,
                    functionName: "createResource",
                    args: [MOCK_RESOURCE_ID, MOCK_PRICE, OWNER_ADDRESS],
                })
            );
        });

        it("waits for the receipt", async () => {
            const { registry, publicClient } = makeRegistry();
            await registry.createResource(MOCK_RESOURCE_ID, MOCK_PRICE, OWNER_ADDRESS);
            expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: MOCK_TX_HASH });
        });

        it("throws if wallet has no account", async () => {
            const { publicClient, walletClient } = makeClients();
            (walletClient as never as { account: null }).account = null;
            const registry = new SettlementRegistry(CONTRACT_ADDRESS, publicClient as never, walletClient as never);
            await expect(registry.createResource(MOCK_RESOURCE_ID, MOCK_PRICE, OWNER_ADDRESS)).rejects.toThrow("must have an account");
        });
    });

    // -------------------------------------------------------------------------
    describe("updatePrice", () => {
        it("returns the tx hash", async () => {
            const { registry } = makeRegistry();
            expect(await registry.updatePrice(MOCK_RESOURCE_ID, HOOK_ADDRESS, MOCK_PRICE)).toBe(MOCK_TX_HASH);
        });

        it("calls writeContract with updateResource and (resource_id, hook, price)", async () => {
            const { registry, walletClient } = makeRegistry();
            await registry.updatePrice(MOCK_RESOURCE_ID, HOOK_ADDRESS, MOCK_PRICE);
            expect(walletClient.writeContract).toHaveBeenCalledWith(
                expect.objectContaining({
                    functionName: "updateResource",
                    args: [MOCK_RESOURCE_ID, HOOK_ADDRESS, MOCK_PRICE],
                })
            );
        });

        it("waits for the receipt", async () => {
            const { registry, publicClient } = makeRegistry();
            await registry.updatePrice(MOCK_RESOURCE_ID, HOOK_ADDRESS, MOCK_PRICE);
            expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: MOCK_TX_HASH });
        });
    });

    // -------------------------------------------------------------------------
    describe("prepareTransferWithAuth", () => {
        const baseParams = {
            paymentRecipient: PAYMENT_RECIPIENT,
            amount: MOCK_PRICE,
            usdcAddress: USDC_ADDRESS,
            usdcDomainName: "USD Coin",
            usdcDomainVersion: "2",
        };

        it("returns a payload with sender, recipient, and amount", async () => {
            const { registry } = makeRegistry();
            const payload = await registry.prepareTransferWithAuth(baseParams);
            expect(payload.sender).toBe(OWNER_ADDRESS);
            expect(payload.paymentRecipient).toBe(PAYMENT_RECIPIENT);
            expect(payload.amount).toBe(MOCK_PRICE);
        });

        it("returns v, r, s from parseSignature", async () => {
            const { registry } = makeRegistry();
            const payload = await registry.prepareTransferWithAuth(baseParams);
            expect(payload.v).toBe(28);
            expect(payload.r).toBe("0x" + "aa".repeat(32));
            expect(payload.s).toBe("0x" + "bb".repeat(32));
        });

        it("generates a unique nonce each call", async () => {
            const { registry } = makeRegistry();
            const a = await registry.prepareTransferWithAuth(baseParams);
            const b = await registry.prepareTransferWithAuth(baseParams);
            expect(a.nonce).not.toBe(b.nonce);
        });

        it("throws if walletClient has no chain", async () => {
            const { publicClient, walletClient } = makeClients();
            (walletClient as never as { chain: null }).chain = null;
            const registry = new SettlementRegistry(CONTRACT_ADDRESS, publicClient as never, walletClient as never);
            await expect(registry.prepareTransferWithAuth(baseParams)).rejects.toThrow("must have a chain");
        });

        it("throws if walletClient has no account", async () => {
            const { publicClient, walletClient } = makeClients();
            (walletClient as never as { account: null }).account = null;
            const registry = new SettlementRegistry(CONTRACT_ADDRESS, publicClient as never, walletClient as never);
            await expect(registry.prepareTransferWithAuth(baseParams)).rejects.toThrow("must have an account");
        });

        it("uses a provided walletClient override", async () => {
            const { registry } = makeRegistry();
            const overrideSign = vi.fn(() => "0xMOCKSIG");
            const overrideWallet = {
                chain: { id: 1, name: "Mainnet" },
                account: { address: OTHER_ADDRESS },
                signTypedData: overrideSign,
            };
            await registry.prepareTransferWithAuth({ ...baseParams, walletClient: overrideWallet as never });
            expect(overrideSign).toHaveBeenCalled();
        });
    });

    // -------------------------------------------------------------------------
    describe("register", () => {
        const preparedRegister = {
            sender: OWNER_ADDRESS,
            paymentRecipient: PAYMENT_RECIPIENT,
            amount: MOCK_PRICE,
            validAfter: 0n,
            validBefore: 9999999999n,
            nonce: ("0x" + "cc".repeat(32)) as Hex,
            v: 28,
            r: ("0x" + "aa".repeat(32)) as Hex,
            s: ("0x" + "bb".repeat(32)) as Hex,
        };

        it("returns the relayer tx hash", async () => {
            const { registry } = makeRegistry();
            const hash = await registry.register({
                resourceId: MOCK_RESOURCE_ID,
                identityCommitment: MOCK_IDENTITY_COMMITMENT,
                relayerPrivateKey: MOCK_RELAYER_KEY,
                preparedRegister,
            });
            expect(hash).toBe(MOCK_TX_HASH);
        });

        it("calls the relayer writeContract with all register args", async () => {
            const { registry } = makeRegistry();
            await registry.register({
                resourceId: MOCK_RESOURCE_ID,
                identityCommitment: MOCK_IDENTITY_COMMITMENT,
                relayerPrivateKey: MOCK_RELAYER_KEY,
                preparedRegister,
            });
            expect(mockRelayerWriteContract).toHaveBeenCalledWith(
                expect.objectContaining({
                    functionName: "register",
                    args: expect.arrayContaining([
                        MOCK_RESOURCE_ID,
                        MOCK_IDENTITY_COMMITMENT,
                        OWNER_ADDRESS,
                    ]),
                })
            );
        });

        it("waits for the receipt after the relayer submits", async () => {
            const { registry, publicClient } = makeRegistry();
            await registry.register({
                resourceId: MOCK_RESOURCE_ID,
                identityCommitment: MOCK_IDENTITY_COMMITMENT,
                relayerPrivateKey: MOCK_RELAYER_KEY,
                preparedRegister,
            });
            expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: MOCK_TX_HASH });
        });

        it("throws if walletClient has no chain", async () => {
            const { publicClient, walletClient } = makeClients();
            (walletClient as never as { chain: null }).chain = null;
            const registry = new SettlementRegistry(CONTRACT_ADDRESS, publicClient as never, walletClient as never);
            await expect(
                registry.register({
                    resourceId: MOCK_RESOURCE_ID,
                    identityCommitment: MOCK_IDENTITY_COMMITMENT,
                    relayerPrivateKey: MOCK_RELAYER_KEY,
                    preparedRegister,
                })
            ).rejects.toThrow("must have a chain");
        });
    });

    // -------------------------------------------------------------------------
    describe("prepareSettle", () => {
        it("throws if no group exists for the resource", async () => {
            const { registry } = makeRegistry({ readContractImpl: () => 0n });
            await expect(
                registry.prepareSettle({ resourceId: MOCK_RESOURCE_ID, identity: {} as never, stealthAddress: STEALTH_ADDRESS })
            ).rejects.toThrow("createResource()");
        });

        it("fetches group members from MemberRegistered logs", async () => {
            const { Group } = await import("@semaphore-protocol/group");
            const spy = vi.spyOn(Group.prototype, "addMember");
            const { registry } = makeRegistry({
                readContractImpl: () => MOCK_GROUP_ID,
                getLogsImpl: () => [
                    { args: { resourceId: MOCK_RESOURCE_ID, identityCommitment: 111n } },
                    { args: { resourceId: MOCK_RESOURCE_ID, identityCommitment: 222n } },
                ],
            });
            await registry.prepareSettle({ resourceId: MOCK_RESOURCE_ID, identity: {} as never, stealthAddress: STEALTH_ADDRESS });
            expect(spy).toHaveBeenCalledTimes(2);
        });

        it("filters out logs from other resource ids", async () => {
            const { Group } = await import("@semaphore-protocol/group");
            const spy = vi.spyOn(Group.prototype, "addMember");
            const OTHER_RESOURCE: Hex = "0x" + "ff".repeat(32) as Hex;
            const { registry } = makeRegistry({
                readContractImpl: () => MOCK_GROUP_ID,
                getLogsImpl: () => [
                    { args: { resourceId: MOCK_RESOURCE_ID, identityCommitment: 111n } },
                    { args: { resourceId: OTHER_RESOURCE, identityCommitment: 999n } },
                ],
            });
            await registry.prepareSettle({ resourceId: MOCK_RESOURCE_ID, identity: {} as never, stealthAddress: STEALTH_ADDRESS });
            expect(spy).toHaveBeenCalledTimes(1);
        });

        it("returns a PrepareSettleResult with bigint proof fields", async () => {
            const { registry } = makeRegistry({ readContractImpl: () => MOCK_GROUP_ID });
            const result = await registry.prepareSettle({ resourceId: MOCK_RESOURCE_ID, identity: {} as never, stealthAddress: STEALTH_ADDRESS });
            expect(result.resourceId).toBe(MOCK_RESOURCE_ID);
            expect(result.stealthAddress).toBe(STEALTH_ADDRESS);
            expect(typeof result.merkleTreeDepth).toBe("bigint");
            expect(typeof result.nullifier).toBe("bigint");
            expect(result.points).toHaveLength(8);
        });

        it("defaults hookData to '0x' when not provided", async () => {
            const { registry } = makeRegistry({ readContractImpl: () => MOCK_GROUP_ID });
            const result = await registry.prepareSettle({ resourceId: MOCK_RESOURCE_ID, identity: {} as never, stealthAddress: STEALTH_ADDRESS });
            expect(result.hookData).toBe("0x");
        });

        it("forwards hookData when provided", async () => {
            const { registry } = makeRegistry({ readContractImpl: () => MOCK_GROUP_ID });
            const result = await registry.prepareSettle({ resourceId: MOCK_RESOURCE_ID, identity: {} as never, stealthAddress: STEALTH_ADDRESS, hookData: "0xdeadbeef" });
            expect(result.hookData).toBe("0xdeadbeef");
        });
    });

    // -------------------------------------------------------------------------
    describe("settle", () => {
        const preparedSettle = {
            resourceId: MOCK_RESOURCE_ID,
            stealthAddress: STEALTH_ADDRESS,
            merkleTreeDepth: 20n,
            merkleTreeRoot: 111n,
            nullifier: 222n,
            message: 333n,
            points: [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n] as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint],
            hookData: "0x" as Hex,
        };

        it("returns the hash and nullifier", async () => {
            const { registry } = makeRegistry();
            const result = await registry.settle({ relayerPrivateKey: MOCK_RELAYER_KEY, preparedSettle });
            expect(result.hash).toBe(MOCK_TX_HASH);
            expect(result.nullifier).toBe(preparedSettle.nullifier);
        });

        it("calls the relayer writeContract with settle args", async () => {
            const { registry } = makeRegistry();
            await registry.settle({ relayerPrivateKey: MOCK_RELAYER_KEY, preparedSettle });
            expect(mockRelayerWriteContract).toHaveBeenCalledWith(
                expect.objectContaining({
                    functionName: "settle",
                    args: expect.arrayContaining([
                        MOCK_RESOURCE_ID,
                        STEALTH_ADDRESS,
                        preparedSettle.merkleTreeDepth,
                        preparedSettle.nullifier,
                    ]),
                })
            );
        });

        it("passes hookData through to the contract", async () => {
            const { registry } = makeRegistry();
            await registry.settle({
                relayerPrivateKey: MOCK_RELAYER_KEY,
                preparedSettle: { ...preparedSettle, hookData: "0xdeadbeef" },
            });
            expect(mockRelayerWriteContract).toHaveBeenCalledWith(
                expect.objectContaining({
                    args: expect.arrayContaining([
                        [222, 173, 190, 239], // 0xdeadbeef as uint8[]
                    ]),
                })
            );
        });

        it("waits for the receipt", async () => {
            const { registry, publicClient } = makeRegistry();
            await registry.settle({ relayerPrivateKey: MOCK_RELAYER_KEY, preparedSettle });
            expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: MOCK_TX_HASH });
        });

        it("throws if walletClient has no chain", async () => {
            const { publicClient, walletClient } = makeClients();
            (walletClient as never as { chain: null }).chain = null;
            const registry = new SettlementRegistry(CONTRACT_ADDRESS, publicClient as never, walletClient as never);
            await expect(registry.settle({ relayerPrivateKey: MOCK_RELAYER_KEY, preparedSettle })).rejects.toThrow("must have a chain");
        });
    });

    // -------------------------------------------------------------------------
    describe("isSettled", () => {
        it("returns true when the contract confirms settlement", async () => {
            const { registry } = makeRegistry({ readContractImpl: () => true });
            expect(await registry.isSettled(STEALTH_ADDRESS, MOCK_RESOURCE_ID)).toBe(true);
        });

        it("returns false when not settled", async () => {
            const { registry } = makeRegistry({ readContractImpl: () => false });
            expect(await registry.isSettled(STEALTH_ADDRESS, MOCK_RESOURCE_ID)).toBe(false);
        });

        it("calls readContract with the correct args", async () => {
            const { registry, publicClient } = makeRegistry({ readContractImpl: () => true });
            await registry.isSettled(STEALTH_ADDRESS, MOCK_RESOURCE_ID);
            expect(publicClient.readContract).toHaveBeenCalledWith(
                expect.objectContaining({ functionName: "isSettled", args: [STEALTH_ADDRESS, MOCK_RESOURCE_ID] })
            );
        });
    });

    // -------------------------------------------------------------------------
    describe("isRegistered", () => {
        it("returns true when the commitment is registered", async () => {
            const { registry } = makeRegistry({ readContractImpl: () => true });
            expect(await registry.isRegistered(MOCK_RESOURCE_ID, MOCK_IDENTITY_COMMITMENT)).toBe(true);
        });

        it("calls readContract with the correct args", async () => {
            const { registry, publicClient } = makeRegistry({ readContractImpl: () => true });
            await registry.isRegistered(MOCK_RESOURCE_ID, MOCK_IDENTITY_COMMITMENT);
            expect(publicClient.readContract).toHaveBeenCalledWith(
                expect.objectContaining({ functionName: "isRegistered", args: [MOCK_RESOURCE_ID, MOCK_IDENTITY_COMMITMENT] })
            );
        });
    });

    // -------------------------------------------------------------------------
    describe("getGroupId", () => {
        it("returns the group id", async () => {
            const { registry } = makeRegistry({ readContractImpl: () => MOCK_GROUP_ID });
            expect(await registry.getGroupId(MOCK_RESOURCE_ID)).toBe(MOCK_GROUP_ID);
        });

        it("calls readContract with the correct args", async () => {
            const { registry, publicClient } = makeRegistry({ readContractImpl: () => MOCK_GROUP_ID });
            await registry.getGroupId(MOCK_RESOURCE_ID);
            expect(publicClient.readContract).toHaveBeenCalledWith(
                expect.objectContaining({ functionName: "getGroupId", args: [MOCK_RESOURCE_ID] })
            );
        });
    });

    // -------------------------------------------------------------------------
    describe("getPrice", () => {
        it("returns the price", async () => {
            const { registry } = makeRegistry({ readContractImpl: () => MOCK_PRICE });
            expect(await registry.getPrice(MOCK_RESOURCE_ID)).toBe(MOCK_PRICE);
        });

        it("calls readContract with the correct args", async () => {
            const { registry, publicClient } = makeRegistry({ readContractImpl: () => MOCK_PRICE });
            await registry.getPrice(MOCK_RESOURCE_ID);
            expect(publicClient.readContract).toHaveBeenCalledWith(
                expect.objectContaining({ functionName: "getPrice", args: [MOCK_RESOURCE_ID] })
            );
        });
    });

    // -------------------------------------------------------------------------
    describe("waitForTransaction", () => {
        it("delegates to publicClient.waitForTransactionReceipt", async () => {
            const receipt = { status: "success", logs: [] };
            const { registry, publicClient } = makeRegistry({ waitForTransactionReceiptImpl: () => receipt });
            const result = await registry.waitForTransaction(MOCK_TX_HASH);
            expect(result).toEqual(receipt);
            expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: MOCK_TX_HASH });
        });
    });
});