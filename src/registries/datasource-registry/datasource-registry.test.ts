import { describe, it, expect, vi } from "vitest";
import { DataSourceRegistry, hashString, MerkleTree, poseidonHash, type ManifestLeaf } from "./index.js";
import { keccak256, encodePacked } from "viem";
import type { Address, Hash, Hex } from "viem";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CONTRACT_ADDRESS: Address = "0x1111111111111111111111111111111111111111";
const OWNER_ADDRESS: Address = "0x3333333333333333333333333333333333333333";

const MOCK_SCHEMA_ID: Hex = "0xdeadbeef00000000000000000000000000000000000000000000000000000000";
const MOCK_TX_HASH: Hash = "0xaabbccdd00000000000000000000000000000000000000000000000000000000";
const MOCK_CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const MOCK_NAME = "track-1";
const MOCK_MERKLE_ROOT: Hex = "0xcafebabe00000000000000000000000000000000000000000000000000000000";

const MOCK_LEAF: ManifestLeaf = {
    index: 0n,
    name: MOCK_NAME,
};

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

function makeLeaves(n: number): ManifestLeaf[] {
    return Array.from({ length: n }, (_, i) => ({
        index: BigInt(i),
        name: `track-${i.toString()}`,
    }));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("DataSourceRegistry", () => {

    // ── publish ─────────────────────────────────────────────────────────────────

    describe("publish", () => {
        it("returns the tx hash on success", async () => {
            const hash = await makeRegistry().publish(MOCK_CID, MOCK_MERKLE_ROOT, MOCK_SCHEMA_ID, MOCK_NAME);
            expect(hash).toBe(MOCK_TX_HASH);
        });

        it("calls writeContract with manifestCid, merkleRoot, schemaId, name", async () => {
            const clients = makeClients();
            await makeRegistry(clients).publish(MOCK_CID, MOCK_MERKLE_ROOT, MOCK_SCHEMA_ID, MOCK_NAME);

            expect(clients.walletClient.writeContract).toHaveBeenCalledWith(
                expect.objectContaining({
                    address: CONTRACT_ADDRESS,
                    functionName: "publish",
                    args: [MOCK_CID, MOCK_MERKLE_ROOT, MOCK_SCHEMA_ID, MOCK_NAME],
                })
            );
        });

        it("applies a 30% gas buffer on top of the estimate", async () => {
            const estimated = 100_000n;
            const clients = makeClients({ estimateContractGasImpl: () => estimated });
            await makeRegistry(clients).publish(MOCK_CID, MOCK_MERKLE_ROOT, MOCK_SCHEMA_ID, MOCK_NAME);

            expect(clients.walletClient.writeContract).toHaveBeenCalledWith(
                expect.objectContaining({ gas: (estimated * 130n) / 100n })
            );
        });

        it("estimates gas with the same publish args and account", async () => {
            const clients = makeClients();
            await makeRegistry(clients).publish(MOCK_CID, MOCK_MERKLE_ROOT, MOCK_SCHEMA_ID, MOCK_NAME);

            expect(clients.publicClient.estimateContractGas).toHaveBeenCalledWith(
                expect.objectContaining({
                    address: CONTRACT_ADDRESS,
                    functionName: "publish",
                    args: [MOCK_CID, MOCK_MERKLE_ROOT, MOCK_SCHEMA_ID, MOCK_NAME],
                    account: { address: OWNER_ADDRESS },
                })
            );
        });

        it("triples maxFeePerGas and passes priority fee through from the fee estimate", async () => {
            const baseFee = 10n;
            const clients = makeClients({
                estimateFeesPerGasImpl: () => ({ maxFeePerGas: baseFee, maxPriorityFeePerGas: 2n }),
            });
            await makeRegistry(clients).publish(MOCK_CID, MOCK_MERKLE_ROOT, MOCK_SCHEMA_ID, MOCK_NAME);

            expect(clients.walletClient.writeContract).toHaveBeenCalledWith(
                expect.objectContaining({ maxFeePerGas: baseFee * 3n, maxPriorityFeePerGas: 2n })
            );
        });

        it("forwards chain and account to writeContract", async () => {
            const clients = makeClients();
            await makeRegistry(clients).publish(MOCK_CID, MOCK_MERKLE_ROOT, MOCK_SCHEMA_ID, MOCK_NAME);

            expect(clients.walletClient.writeContract).toHaveBeenCalledWith(
                expect.objectContaining({
                    chain: { id: 42161, name: "Arbitrum One" },
                    account: { address: OWNER_ADDRESS },
                })
            );
        });

        it("waits for the transaction receipt", async () => {
            const clients = makeClients();
            await makeRegistry(clients).publish(MOCK_CID, MOCK_MERKLE_ROOT, MOCK_SCHEMA_ID, MOCK_NAME);
            expect(clients.publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: MOCK_TX_HASH });
        });

        it("throws when the wallet client has no chain", async () => {
            const clients = makeClients();
            (clients.walletClient as { chain?: unknown }).chain = undefined;
            await expect(
                makeRegistry(clients).publish(MOCK_CID, MOCK_MERKLE_ROOT, MOCK_SCHEMA_ID, MOCK_NAME)
            ).rejects.toThrow("Chain required");
        });

        it("throws when the wallet client has no account", async () => {
            const clients = makeClients();
            (clients.walletClient as { account?: unknown }).account = undefined;
            await expect(
                makeRegistry(clients).publish(MOCK_CID, MOCK_MERKLE_ROOT, MOCK_SCHEMA_ID, MOCK_NAME)
            ).rejects.toThrow("Account required");
        });
    });

    // ── get ─────────────────────────────────────────────────────────────────────

    describe("get", () => {
        it("returns manifestCid, merkleRoot, name, schemaId, and version", async () => {
            const mockVersion = 3n;
            const clients = makeClients({
                readContractImpl: (args: unknown) => {
                    const { functionName } = args as { functionName: string };
                    if (functionName === "get") return [MOCK_CID, MOCK_MERKLE_ROOT];
                    if (functionName === "getVersion") return mockVersion;
                },
            });

            const result = await makeRegistry(clients).get(OWNER_ADDRESS, MOCK_SCHEMA_ID, MOCK_NAME);

            expect(result).toEqual({
                manifestCid: MOCK_CID,
                merkleRoot: MOCK_MERKLE_ROOT,
                name: MOCK_NAME,
                schemaId: MOCK_SCHEMA_ID,
                version: mockVersion,
            });
        });

        it("issues get and getVersion calls", async () => {
            const callOrder: string[] = [];
            const clients = makeClients({
                readContractImpl: (args: unknown) => {
                    const { functionName } = args as { functionName: string };
                    callOrder.push(functionName);
                    return functionName === "get" ? [MOCK_CID, MOCK_MERKLE_ROOT] : 1n;
                },
            });

            await makeRegistry(clients).get(OWNER_ADDRESS, MOCK_SCHEMA_ID, MOCK_NAME);

            expect(callOrder).toContain("get");
            expect(callOrder).toContain("getVersion");
            expect(clients.publicClient.readContract).toHaveBeenCalledTimes(2);
        });

        it("passes the same args through to both contract calls", async () => {
            const clients = makeClients({
                readContractImpl: (args: unknown) => {
                    const { functionName } = args as { functionName: string };
                    return functionName === "get" ? [MOCK_CID, MOCK_MERKLE_ROOT] : 1n;
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

    // ── resourceId (static) ───────────────────────────────────────────────────────

    describe("resourceId", () => {
        it("matches the contract derivation: keccak256(owner ++ schema_id ++ keccak256(name))", () => {
            const nameHash = keccak256(new TextEncoder().encode(MOCK_NAME) as Uint8Array<ArrayBuffer>);
            const expected = keccak256(
                encodePacked(
                    ["address", "bytes32", "bytes32"],
                    [OWNER_ADDRESS, MOCK_SCHEMA_ID, nameHash],
                )
            );

            expect(DataSourceRegistry.resourceId(OWNER_ADDRESS, MOCK_SCHEMA_ID, MOCK_NAME)).toBe(expected);
        });

        it("produces different ids for different names", () => {
            const a = DataSourceRegistry.resourceId(OWNER_ADDRESS, MOCK_SCHEMA_ID, "track-1");
            const b = DataSourceRegistry.resourceId(OWNER_ADDRESS, MOCK_SCHEMA_ID, "track-2");
            expect(a).not.toBe(b);
        });

        it("produces different ids for different schemas", () => {
            const schemaB: Hex = "0xbebebebe00000000000000000000000000000000000000000000000000000000";
            const a = DataSourceRegistry.resourceId(OWNER_ADDRESS, MOCK_SCHEMA_ID, MOCK_NAME);
            const b = DataSourceRegistry.resourceId(OWNER_ADDRESS, schemaB, MOCK_NAME);
            expect(a).not.toBe(b);
        });

        it("is deterministic", () => {
            expect(DataSourceRegistry.resourceId(OWNER_ADDRESS, MOCK_SCHEMA_ID, MOCK_NAME))
                .toBe(DataSourceRegistry.resourceId(OWNER_ADDRESS, MOCK_SCHEMA_ID, MOCK_NAME));
        });

        it("makes no RPC calls", () => {
            const clients = makeClients();
            DataSourceRegistry.resourceId(OWNER_ADDRESS, MOCK_SCHEMA_ID, MOCK_NAME);
            expect(clients.publicClient.readContract).not.toHaveBeenCalled();
        });
    });

    // ── hashName (static) ─────────────────────────────────────────────────────────

    describe("hashName", () => {
        it("produces the keccak256 of the UTF-8 encoded name", () => {
            const expected = keccak256(new TextEncoder().encode(MOCK_NAME) as Uint8Array<ArrayBuffer>);
            expect(DataSourceRegistry.hashName(MOCK_NAME)).toBe(expected);
        });

        it("is consistent with resourceId's internal name hash", () => {
            const nameHash = DataSourceRegistry.hashName(MOCK_NAME);
            const fromResourceId = DataSourceRegistry.resourceId(OWNER_ADDRESS, MOCK_SCHEMA_ID, MOCK_NAME);
            const manual = keccak256(
                encodePacked(["address", "bytes32", "bytes32"], [OWNER_ADDRESS, MOCK_SCHEMA_ID, nameHash])
            );
            expect(fromResourceId).toBe(manual);
        });
    });
});

// ── MerkleTree ──────────────────────────────────────────────────────────────────

describe("MerkleTree", () => {

    // ── leafHash ──────────────────────────────────────────────────────────────────

    describe("leafHash", () => {
        it("matches poseidon2(index, hashString(name))", () => {
            const expected = poseidonHash([MOCK_LEAF.index, hashString(MOCK_LEAF.name)]);
            expect(MerkleTree.leafHash(MOCK_LEAF)).toBe(expected);
        });

        it("is deterministic", () => {
            expect(MerkleTree.leafHash(MOCK_LEAF)).toBe(MerkleTree.leafHash(MOCK_LEAF));
        });

        it("differs when index changes", () => {
            const a = MerkleTree.leafHash({ ...MOCK_LEAF, index: 0n });
            const b = MerkleTree.leafHash({ ...MOCK_LEAF, index: 1n });
            expect(a).not.toBe(b);
        });

        it("differs when name changes", () => {
            const a = MerkleTree.leafHash({ ...MOCK_LEAF, name: "track-a" });
            const b = MerkleTree.leafHash({ ...MOCK_LEAF, name: "track-b" });
            expect(a).not.toBe(b);
        });
    });

    // ── buildTree ───────────────────────────────────────────────────────────────

    describe("buildTree", () => {
        it("throws on an empty tree", () => {
            expect(() => MerkleTree.buildTree([])).toThrow("Empty tree");
        });

        it("returns leafHash itself as the root for a single leaf", () => {
            const { root, layers } = MerkleTree.buildTree([MOCK_LEAF]);
            expect(root).toBe(MerkleTree.leafHash(MOCK_LEAF));
            expect(layers).toHaveLength(1);
            expect(layers[0]).toHaveLength(1);
        });

        it("hashes a pair of leaves into the root", () => {
            const leaves = makeLeaves(2);
            const h0 = MerkleTree.leafHash(leaves[0]);
            const h1 = MerkleTree.leafHash(leaves[1]);
            const expected = poseidonHash([h0, h1]);

            const { root } = MerkleTree.buildTree(leaves);
            expect(root).toBe(expected);
        });

        it("sorts leaves by index before hashing", () => {
            const leaves = makeLeaves(4);
            const a = MerkleTree.buildTree(leaves);
            const b = MerkleTree.buildTree([...leaves].reverse());
            expect(a.root).toBe(b.root);
        });

        it("duplicates the last node when a layer has an odd count", () => {
            const leaves = makeLeaves(3);
            const [h0, h1, h2] = leaves.map(leaf => MerkleTree.leafHash(leaf));
            // odd node h2 is paired with itself
            const expected = poseidonHash([
                poseidonHash([h0, h1]),
                poseidonHash([h2, h2]),
            ]);

            const { root } = MerkleTree.buildTree(leaves);
            expect(root).toBe(expected);
        });

        it("produces log2(n) + 1 layers for power-of-two leaf counts", () => {
            const { layers } = MerkleTree.buildTree(makeLeaves(8));
            expect(layers).toHaveLength(4);
            expect(layers[0]).toHaveLength(8);
            expect(layers[3]).toHaveLength(1);
        });

        it("differs when any leaf changes", () => {
            const leaves = makeLeaves(4);
            const baseline = MerkleTree.buildTree(leaves).root;
            const mutated = MerkleTree.buildTree([
                ...leaves.slice(0, 3),
                { ...leaves[3], name: "changed" },
            ]).root;
            expect(baseline).not.toBe(mutated);
        });

        it("handles names longer than one field element (>31 bytes)", () => {
            const long = "track-" + "x".repeat(40); // 46 bytes -> 2 elements
            expect(MerkleTree.leafHash({ index: 0n, name: long }))
                .toBe(poseidonHash([0n, hashString(long)]));
            expect(hashString(long)).not.toBe(hashString("track-x"));
        });
    });

    // ── buildProof ────────────────────────────────────────────────────────────────

    describe("buildProof", () => {
        it("returns an empty proof for a single-leaf tree", () => {
            const { layers } = MerkleTree.buildTree([MOCK_LEAF]);
            expect(MerkleTree.buildProof(layers, 0)).toEqual([]);
        });

        it("produces a 1-element proof for two leaves, verifiable by recompute", () => {
            const leaves = makeLeaves(2);
            const { root, layers } = MerkleTree.buildTree(leaves);
            const proof = MerkleTree.buildProof(layers, 0);
            expect(proof).toHaveLength(1);

            const target = MerkleTree.leafHash(leaves[0]);
            const recomputed = poseidonHash([target, proof[0]]);
            expect(recomputed).toBe(root);
        });

        it("produces proof of depth log2(n) for power-of-two trees", () => {
            const { layers } = MerkleTree.buildTree(makeLeaves(8));
            expect(MerkleTree.buildProof(layers, 3)).toHaveLength(3);
        });

        it("verifies an arbitrary leaf against the root via sorted recompute", () => {
            const leaves = makeLeaves(4);
            const { root, layers } = MerkleTree.buildTree(leaves);
            const targetIndex = 2;
            const proof = MerkleTree.buildProof(layers, targetIndex);

            let node = MerkleTree.leafHash(leaves[targetIndex]);
            let idx = targetIndex;
            for (const sibling of proof) {
                node = idx % 2 === 0
                    ? poseidonHash([node, sibling])
                    : poseidonHash([sibling, node]);
                idx = Math.floor(idx / 2);
            }
            expect(node).toBe(root);
        });
    });

    // ── rootToHex ───────────────────────────────────────────────────────────────

    describe("rootToHex", () => {
        it("renders a bigint root as a 0x-prefixed, 64-char hex string", () => {
            const hex = MerkleTree.rootToHex(255n);
            expect(hex).toBe(`0x${"0".repeat(62)}ff`);
            expect(hex).toMatch(/^0x[0-9a-f]{64}$/);
        });

        it("round-trips a real root through hex", () => {
            const { root } = MerkleTree.buildTree(makeLeaves(4));
            const hex = MerkleTree.rootToHex(root);
            expect(BigInt(hex)).toBe(root);
        });
    });
});
