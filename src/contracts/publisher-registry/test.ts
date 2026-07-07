 import { describe, it, expect, beforeEach, vi, type Mocked } from "vitest";
import { type PublicClient, type WalletClient, type Address, type Hex } from "viem";
import { PublisherRegistry } from "./index.js";
import { PUBLISHER_REGISTRY_ABI } from "./abi.js";

const MOCK_CONTRACT_ADDRESS: Address = "0x1111111111111111111111111111111111111111";
const MOCK_ACCOUNT: Address = "0x2222222222222222222222222222222222222222";
const MOCK_BUCKET: Address = "0x3333333333333333333333333333333333333333";
const MOCK_TX_HASH: Hex = "0xabc123";

describe("PublisherRegistry", () => {
    let publicClient: Mocked<PublicClient>;
    let walletClient: Mocked<WalletClient>;
    let registry: PublisherRegistry;

    beforeEach(() => {
        // 1. Mock PublicClient
        publicClient = {
            readContract: vi.fn(),
            estimateFeesPerGas: vi.fn().mockResolvedValue({
                maxFeePerGas: 1000000000n,
                maxPriorityFeePerGas: 100000000n,
            }),
            estimateContractGas: vi.fn().mockResolvedValue(50000n),
            waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "success" }),
        } as unknown as Mocked<PublicClient>;

        // 2. Mock WalletClient
        walletClient = {
            chain: { id: 1 },
            account: MOCK_ACCOUNT,
            writeContract: vi.fn().mockResolvedValue(MOCK_TX_HASH),
        } as unknown as Mocked<WalletClient>;

        // 3. Instantiate Wrapper
        registry = new PublisherRegistry(
            MOCK_CONTRACT_ADDRESS,
            publicClient,
            walletClient
        );
    });

    describe("Reads", () => {
        it("should fetch bucketOf a publisher", async () => {
            publicClient.readContract.mockResolvedValueOnce(MOCK_BUCKET);

            const result = await registry.bucketOf(MOCK_ACCOUNT);

            expect(publicClient.readContract).toHaveBeenCalledWith({
                address: MOCK_CONTRACT_ADDRESS,
                abi: PUBLISHER_REGISTRY_ABI,
                functionName: "bucketOf",
                args: [MOCK_ACCOUNT],
            });
            expect(result).toBe(MOCK_BUCKET);
        });

        it("should fetch the registration fee", async () => {
            const expectedFee = 1000n;
            publicClient.readContract.mockResolvedValueOnce(expectedFee);

            const result = await registry.registrationFee();

            expect(publicClient.readContract).toHaveBeenCalledWith({
                address: MOCK_CONTRACT_ADDRESS,
                abi: PUBLISHER_REGISTRY_ABI,
                functionName: "registrationFee",
            });
            expect(result).toBe(expectedFee);
        });
    });

    describe("Writes", () => {
        it("should register a publisher and pass the registration fee as msg.value", async () => {
            const fee = 500n;
            // Mock readContract specifically for the `this.registrationFee()` call inside `register()`
            publicClient.readContract.mockResolvedValueOnce(fee);

            const hash = await registry.register();

            // Verify Gas Estimation
            expect(publicClient.estimateContractGas).toHaveBeenCalledWith({
                address: MOCK_CONTRACT_ADDRESS,
                abi: PUBLISHER_REGISTRY_ABI,
                functionName: "register",
                args: [],
                account: MOCK_ACCOUNT,
                value: fee, // Ensure value is passed to gas estimation
            });

            // Verify Write
            expect(walletClient.writeContract).toHaveBeenCalledWith(
                expect.objectContaining({
                    address: MOCK_CONTRACT_ADDRESS,
                    abi: PUBLISHER_REGISTRY_ABI,
                    functionName: "register",
                    args: [],
                    account: MOCK_ACCOUNT,
                    value: fee, // Ensure value is passed to the transaction
                    gas: (50000n * 130n) / 100n, // 30% buffer applied
                })
            );

            // Verify Receipt Wait
            expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: MOCK_TX_HASH });
            expect(hash).toBe(MOCK_TX_HASH);
        });

        it("should register a schema", async () => {
            const hash = await registry.registerSchema("my_schema", "cid_123", "agent_456");

            expect(walletClient.writeContract).toHaveBeenCalledWith(
                expect.objectContaining({
                    functionName: "registerSchema",
                    args: ["my_schema", "cid_123", "agent_456"],
                })
            );
            expect(hash).toBe(MOCK_TX_HASH);
        });

        it("should publish a dataset", async () => {
            const merkleRoot: Hex = "0x0000000000000000000000000000000000000000000000000000000000000000";
            
            const hash = await registry.publish(
                "manifest_cid",
                merkleRoot,
                "schema_name",
                "dataset_name"
            );

            expect(walletClient.writeContract).toHaveBeenCalledWith(
                expect.objectContaining({
                    functionName: "publish",
                    args: ["manifest_cid", merkleRoot, "schema_name", "dataset_name"],
                })
            );
            expect(hash).toBe(MOCK_TX_HASH);
        });
    });

    describe("Error Handling", () => {
        it("should throw if wallet chain is missing", async () => {
            // Remove chain to simulate uninitialized wallet
            (walletClient as any).chain = undefined;

            await expect(registry.deleteSchema("test")).rejects.toThrow("Chain required");
        });

        it("should throw if wallet account is missing", async () => {
            // Remove account
            (walletClient as any).account = undefined;

            await expect(registry.deleteSchema("test")).rejects.toThrow("Account required");
        });
    });
});