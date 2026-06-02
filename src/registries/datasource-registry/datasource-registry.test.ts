// import { describe, it, expect, vi } from "vitest";
// import { DataSourceRegistry, type ManifestLeaf } from "./index.js";
// import { keccak256, encodePacked } from "viem";
// import type { Address, Hash, Hex } from "viem";

// // ── Fixtures ──────────────────────────────────────────────────────────────────

// const CONTRACT_ADDRESS: Address = "0x1111111111111111111111111111111111111111";
// const OWNER_ADDRESS: Address    = "0x3333333333333333333333333333333333333333";

// const MOCK_SCHEMA_ID: Hex   = "0xdeadbeef00000000000000000000000000000000000000000000000000000000";
// const MOCK_TX_HASH: Hash    = "0xaabbccdd00000000000000000000000000000000000000000000000000000000";
// const MOCK_CID              = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
// const MOCK_LEAF_CID         = "bafyleaf0000000000000000000000000000000000000000000000000000000";
// const MOCK_LEAF_META        = "bafyleafmeta0000000000000000000000000000000000000000000000000";
// const MOCK_NAME             = "track-1";
// const MOCK_MERKLE_ROOT: Hex = "0xcafebabe00000000000000000000000000000000000000000000000000000000";

// const MOCK_LEAF: ManifestLeaf = {
//     index: 0n,
//     contentCid: MOCK_LEAF_CID,
//     price: 1_000_000n,
//     metadataCid: MOCK_LEAF_META,
// };

// // ── Mock factory ──────────────────────────────────────────────────────────────

// function makeMockReceipt() {
//     return { status: "success", blockNumber: 1n };
// }

// function makeClients({
//     readContractImpl,
//     estimateContractGasImpl,
//     estimateFeesPerGasImpl,
//     writeContractImpl,
//     waitForTransactionReceiptImpl,
// }: {
//     readContractImpl?: (args: unknown) => unknown;
//     estimateContractGasImpl?: () => bigint;
//     estimateFeesPerGasImpl?: () => { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
//     writeContractImpl?: () => Hash;
//     waitForTransactionReceiptImpl?: () => unknown;
// } = {}) {
//     const publicClient = {
//         readContract: vi.fn(readContractImpl ?? (() => undefined)),
//         estimateContractGas: vi.fn(estimateContractGasImpl ?? (() => 100_000n)),
//         estimateFeesPerGas: vi.fn(
//             estimateFeesPerGasImpl ?? (() => ({ maxFeePerGas: 10n, maxPriorityFeePerGas: 1n }))
//         ),
//         waitForTransactionReceipt: vi.fn(
//             waitForTransactionReceiptImpl ?? (() => makeMockReceipt())
//         ),
//     };

//     const walletClient = {
//         chain: { id: 42161, name: "Arbitrum One" },
//         account: { address: OWNER_ADDRESS },
//         writeContract: vi.fn(writeContractImpl ?? (() => MOCK_TX_HASH)),
//     };

//     return { publicClient, walletClient };
// }

// function makeRegistry(clients = makeClients()) {
//     return new DataSourceRegistry(
//         CONTRACT_ADDRESS,
//         clients.publicClient as never,
//         clients.walletClient as never,
//     );
// }

// // ── Tests ─────────────────────────────────────────────────────────────────────

// describe("DataSourceRegistry", () => {

//     describe("constructor / getContractAddress", () => {
//         it("returns the address it was initialized with", () => {
//             expect(makeRegistry().getContractAddress()).toBe(CONTRACT_ADDRESS);
//         });
//     });

//     // ── publish ───────────────────────────────────────────────────────────────

//     describe("publish", () => {
//         it("returns the tx hash on success", async () => {
//             const hash = await makeRegistry().publish(MOCK_CID, MOCK_MERKLE_ROOT, MOCK_SCHEMA_ID, MOCK_NAME);
//             expect(hash).toBe(MOCK_TX_HASH);
//         });

//         it("calls writeContract with manifestCid, merkleRoot, schemaId, name", async () => {
//             const clients = makeClients();
//             await makeRegistry(clients).publish(MOCK_CID, MOCK_MERKLE_ROOT, MOCK_SCHEMA_ID, MOCK_NAME);

//             expect(clients.walletClient.writeContract).toHaveBeenCalledWith(
//                 expect.objectContaining({
//                     address: CONTRACT_ADDRESS,
//                     functionName: "publish",
//                     args: [MOCK_CID, MOCK_MERKLE_ROOT, MOCK_SCHEMA_ID, MOCK_NAME],
//                 })
//             );
//         });

//         it("applies a 30% gas buffer on top of the estimate", async () => {
//             const estimated = 100_000n;
//             const clients = makeClients({ estimateContractGasImpl: () => estimated });
//             await makeRegistry(clients).publish(MOCK_CID, MOCK_MERKLE_ROOT, MOCK_SCHEMA_ID, MOCK_NAME);

//             expect(clients.walletClient.writeContract).toHaveBeenCalledWith(
//                 expect.objectContaining({ gas: (estimated * 130n) / 100n })
//             );
//         });

//         it("uses the gas override and skips estimation", async () => {
//             const clients = makeClients();
//             const override = 999_999n;
//             await makeRegistry(clients).publish(MOCK_CID, MOCK_MERKLE_ROOT, MOCK_SCHEMA_ID, MOCK_NAME, override);

//             expect(clients.publicClient.estimateContractGas).not.toHaveBeenCalled();
//             expect(clients.walletClient.writeContract).toHaveBeenCalledWith(
//                 expect.objectContaining({ gas: override })
//             );
//         });

//         it("triples maxFeePerGas from the fee estimate", async () => {
//             const baseFee = 10n;
//             const clients = makeClients({
//                 estimateFeesPerGasImpl: () => ({ maxFeePerGas: baseFee, maxPriorityFeePerGas: 2n }),
//             });
//             await makeRegistry(clients).publish(MOCK_CID, MOCK_MERKLE_ROOT, MOCK_SCHEMA_ID, MOCK_NAME);

//             expect(clients.walletClient.writeContract).toHaveBeenCalledWith(
//                 expect.objectContaining({ maxFeePerGas: baseFee * 3n, maxPriorityFeePerGas: 2n })
//             );
//         });

//         it("waits for the transaction receipt", async () => {
//             const clients = makeClients();
//             await makeRegistry(clients).publish(MOCK_CID, MOCK_MERKLE_ROOT, MOCK_SCHEMA_ID, MOCK_NAME);
//             expect(clients.publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: MOCK_TX_HASH });
//         });
//     });

//     // ── leafHash ──────────────────────────────────────────────────────────────

//     describe("leafHash", () => {
//         it("matches keccak256(index || contentCid || price || metadataCid)", () => {
//             const expected = keccak256(
//                 encodePacked(
//                     ["uint256", "string", "uint256", "string"],
//                     [MOCK_LEAF.index, MOCK_LEAF.contentCid, MOCK_LEAF.price, MOCK_LEAF.metadataCid],
//                 ),
//             );
//             expect(DataSourceRegistry.leafHash(MOCK_LEAF)).toBe(expected);
//         });

//         it("is deterministic", () => {
//             expect(DataSourceRegistry.leafHash(MOCK_LEAF))
//                 .toBe(DataSourceRegistry.leafHash(MOCK_LEAF));
//         });

//         it("differs when index changes", () => {
//             const a = DataSourceRegistry.leafHash({ ...MOCK_LEAF, index: 0n });
//             const b = DataSourceRegistry.leafHash({ ...MOCK_LEAF, index: 1n });
//             expect(a).not.toBe(b);
//         });

//         it("differs when price changes", () => {
//             const a = DataSourceRegistry.leafHash({ ...MOCK_LEAF, price: 100n });
//             const b = DataSourceRegistry.leafHash({ ...MOCK_LEAF, price: 200n });
//             expect(a).not.toBe(b);
//         });

//         it("differs when contentCid changes", () => {
//             const a = DataSourceRegistry.leafHash({ ...MOCK_LEAF, contentCid: "bafyA" });
//             const b = DataSourceRegistry.leafHash({ ...MOCK_LEAF, contentCid: "bafyB" });
//             expect(a).not.toBe(b);
//         });

//         it("differs when metadataCid changes", () => {
//             const a = DataSourceRegistry.leafHash({ ...MOCK_LEAF, metadataCid: "M1" });
//             const b = DataSourceRegistry.leafHash({ ...MOCK_LEAF, metadataCid: "M2" });
//             expect(a).not.toBe(b);
//         });

//         it("free leaf (price=0) hashes distinctly from paid leaf", () => {
//             const free = DataSourceRegistry.leafHash({ ...MOCK_LEAF, price: 0n });
//             const paid = DataSourceRegistry.leafHash({ ...MOCK_LEAF, price: 1n });
//             expect(free).not.toBe(paid);
//         });
//     });

//     // ── buildMerkleRoot ───────────────────────────────────────────────────────

//     describe("buildMerkleRoot", () => {
//         it("throws on empty manifest", () => {
//             expect(() => DataSourceRegistry.buildMerkleRoot([])).toThrow("Empty manifest");
//         });

//         it("returns leafHash itself for a single-leaf manifest", () => {
//             const root = DataSourceRegistry.buildMerkleRoot([MOCK_LEAF]);
//             expect(root).toBe(DataSourceRegistry.leafHash(MOCK_LEAF));
//         });

//         it("uses sorted-pair concatenation for two leaves", () => {
//             const leaf0 = MOCK_LEAF;
//             const leaf1 = { ...MOCK_LEAF, index: 1n, contentCid: "bafyB" };
//             const h0 = DataSourceRegistry.leafHash(leaf0);
//             const h1 = DataSourceRegistry.leafHash(leaf1);
//             const [lo, hi] = h0.toLowerCase() <= h1.toLowerCase() ? [h0, h1] : [h1, h0];
//             const expected = keccak256(encodePacked(["bytes32", "bytes32"], [lo, hi]));

//             expect(DataSourceRegistry.buildMerkleRoot([leaf0, leaf1])).toBe(expected);
//         });

//         it("is deterministic regardless of input order", () => {
//             const leaves: ManifestLeaf[] = [
//                 { ...MOCK_LEAF, index: 0n },
//                 { ...MOCK_LEAF, index: 1n, contentCid: "B" },
//                 { ...MOCK_LEAF, index: 2n, contentCid: "C" },
//                 { ...MOCK_LEAF, index: 3n, contentCid: "D" },
//             ];
//             const a = DataSourceRegistry.buildMerkleRoot(leaves);
//             const b = DataSourceRegistry.buildMerkleRoot([...leaves].reverse());
//             expect(a).toBe(b);
//         });

//         it("differs when any leaf changes", () => {
//             const leaves: ManifestLeaf[] = [
//                 { ...MOCK_LEAF, index: 0n },
//                 { ...MOCK_LEAF, index: 1n, contentCid: "B" },
//             ];
//             const baseline = DataSourceRegistry.buildMerkleRoot(leaves);
//             const mutated = DataSourceRegistry.buildMerkleRoot([
//                 leaves[0],
//                 { ...leaves[1], price: leaves[1].price + 1n },
//             ]);
//             expect(baseline).not.toBe(mutated);
//         });
//     });

//     // ── buildLeafProof ────────────────────────────────────────────────────────

//     describe("buildLeafProof", () => {
//         it("returns empty proof for a single-leaf manifest with root == leaf", () => {
//             const { root, proof } = DataSourceRegistry.buildLeafProof([MOCK_LEAF], MOCK_LEAF.index);
//             expect(proof).toEqual([]);
//             expect(root).toBe(DataSourceRegistry.leafHash(MOCK_LEAF));
//         });

//         it("throws on empty manifest", () => {
//             expect(() => DataSourceRegistry.buildLeafProof([], 0n)).toThrow("Empty manifest");
//         });

//         it("throws when target leaf is missing", () => {
//             expect(() => DataSourceRegistry.buildLeafProof([MOCK_LEAF], 99n))
//                 .toThrow("Leaf 99 not in manifest");
//         });

//         it("produces a 1-element proof for 2 leaves, verifiable by recompute", () => {
//             const leaves: ManifestLeaf[] = [
//                 MOCK_LEAF,
//                 { ...MOCK_LEAF, index: 1n, contentCid: "B" },
//             ];
//             const { root, proof } = DataSourceRegistry.buildLeafProof(leaves, 0n);
//             expect(proof.length).toBe(1);

//             const target = DataSourceRegistry.leafHash(leaves[0]);
//             const sibling = proof[0];
//             const [lo, hi] = target.toLowerCase() <= sibling.toLowerCase()
//                 ? [target, sibling]
//                 : [sibling, target];
//             const recomputed = keccak256(encodePacked(["bytes32", "bytes32"], [lo, hi]));
//             expect(recomputed).toBe(root);
//         });

//         it("produces proof of depth = log2(n) for power-of-two manifests", () => {
//             const leaves: ManifestLeaf[] = Array.from({ length: 8 }, (_, i) => ({
//                 index: BigInt(i),
//                 contentCid: `bafy${i}`,
//                 price: BigInt(i * 1000),
//                 metadataCid: `bafyM${i}`,
//             }));
//             const { proof } = DataSourceRegistry.buildLeafProof(leaves, 3n);
//             expect(proof.length).toBe(3);
//         });

//         it("root matches buildMerkleRoot for the same manifest", () => {
//             const leaves: ManifestLeaf[] = [
//                 MOCK_LEAF,
//                 { ...MOCK_LEAF, index: 1n, contentCid: "B" },
//                 { ...MOCK_LEAF, index: 2n, contentCid: "C" },
//                 { ...MOCK_LEAF, index: 3n, contentCid: "D" },
//             ];
//             const { root } = DataSourceRegistry.buildLeafProof(leaves, 2n);
//             expect(root).toBe(DataSourceRegistry.buildMerkleRoot(leaves));
//         });
//     });

//     // ── get ───────────────────────────────────────────────────────────────────

//     describe("get", () => {
//         it("returns manifestCid, merkleRoot, name, schemaId, and version", async () => {
//             const mockVersion = 3n;
//             const clients = makeClients({
//                 readContractImpl: (args: unknown) => {
//                     const { functionName } = args as { functionName: string };
//                     if (functionName === "get") return [MOCK_CID, MOCK_MERKLE_ROOT];
//                     if (functionName === "getVersion") return mockVersion;
//                 },
//             });

//             const result = await makeRegistry(clients).get(OWNER_ADDRESS, MOCK_SCHEMA_ID, MOCK_NAME);

//             expect(result).toEqual({
//                 manifestCid: MOCK_CID,
//                 merkleRoot: MOCK_MERKLE_ROOT,
//                 name: MOCK_NAME,
//                 schemaId: MOCK_SCHEMA_ID,
//                 version: mockVersion,
//             });
//         });

//         it("issues get and getVersion calls in parallel", async () => {
//             const callOrder: string[] = [];
//             const clients = makeClients({
//                 readContractImpl: (args: unknown) => {
//                     const { functionName } = args as { functionName: string };
//                     callOrder.push(functionName);
//                     return functionName === "get" ? [MOCK_CID, MOCK_MERKLE_ROOT] : 1n;
//                 },
//             });

//             await makeRegistry(clients).get(OWNER_ADDRESS, MOCK_SCHEMA_ID, MOCK_NAME);

//             expect(callOrder).toContain("get");
//             expect(callOrder).toContain("getVersion");
//             expect(clients.publicClient.readContract).toHaveBeenCalledTimes(2);
//         });

//         it("passes the same args through to both contract calls", async () => {
//             const clients = makeClients({
//                 readContractImpl: (args: unknown) => {
//                     const { functionName } = args as { functionName: string };
//                     return functionName === "get" ? [MOCK_CID, MOCK_MERKLE_ROOT] : 1n;
//                 },
//             });

//             await makeRegistry(clients).get(OWNER_ADDRESS, MOCK_SCHEMA_ID, MOCK_NAME);

//             expect(clients.publicClient.readContract).toHaveBeenCalledWith(
//                 expect.objectContaining({ functionName: "get", args: [OWNER_ADDRESS, MOCK_SCHEMA_ID, MOCK_NAME] })
//             );
//             expect(clients.publicClient.readContract).toHaveBeenCalledWith(
//                 expect.objectContaining({ functionName: "getVersion", args: [OWNER_ADDRESS, MOCK_SCHEMA_ID, MOCK_NAME] })
//             );
//         });
//     });

//     // ── getByHash ─────────────────────────────────────────────────────────────

//     describe("getByHash", () => {
//         it("returns manifestCid and merkleRoot tuple", async () => {
//             const nameHash: Hex = "0xabcd000000000000000000000000000000000000000000000000000000000000";
//             const clients = makeClients({ readContractImpl: () => [MOCK_CID, MOCK_MERKLE_ROOT] });

//             const result = await makeRegistry(clients).getByHash(OWNER_ADDRESS, MOCK_SCHEMA_ID, nameHash);

//             expect(result).toEqual({ manifestCid: MOCK_CID, merkleRoot: MOCK_MERKLE_ROOT });
//             expect(clients.publicClient.readContract).toHaveBeenCalledWith(
//                 expect.objectContaining({
//                     functionName: "getByHash",
//                     args: [OWNER_ADDRESS, MOCK_SCHEMA_ID, nameHash],
//                 })
//             );
//         });
//     });

//     // ── getMerkleRoot ─────────────────────────────────────────────────────────

//     describe("getMerkleRoot", () => {
//         it("returns the merkle root for the (owner, schema, nameHash)", async () => {
//             const nameHash: Hex = "0xabcd000000000000000000000000000000000000000000000000000000000000";
//             const clients = makeClients({ readContractImpl: () => MOCK_MERKLE_ROOT });

//             const result = await makeRegistry(clients).getMerkleRoot(OWNER_ADDRESS, MOCK_SCHEMA_ID, nameHash);

//             expect(result).toBe(MOCK_MERKLE_ROOT);
//             expect(clients.publicClient.readContract).toHaveBeenCalledWith(
//                 expect.objectContaining({
//                     functionName: "getMerkleRoot",
//                     args: [OWNER_ADDRESS, MOCK_SCHEMA_ID, nameHash],
//                 })
//             );
//         });
//     });

//     // ── getName ───────────────────────────────────────────────────────────────

//     describe("getName", () => {
//         it("calls getName with the name_hash and returns the original string", async () => {
//             const nameHash: Hex = "0xabcd000000000000000000000000000000000000000000000000000000000000";
//             const clients = makeClients({ readContractImpl: () => MOCK_NAME });

//             const result = await makeRegistry(clients).getName(OWNER_ADDRESS, MOCK_SCHEMA_ID, nameHash);

//             expect(result).toBe(MOCK_NAME);
//             expect(clients.publicClient.readContract).toHaveBeenCalledWith(
//                 expect.objectContaining({
//                     functionName: "getName",
//                     args: [OWNER_ADDRESS, MOCK_SCHEMA_ID, nameHash],
//                 })
//             );
//         });
//     });

//     // ── getVersion ────────────────────────────────────────────────────────────

//     describe("getVersion", () => {
//         it("calls getVersion with name and returns the current version", async () => {
//             const clients = makeClients({ readContractImpl: () => 7n });

//             const version = await makeRegistry(clients).getVersion(OWNER_ADDRESS, MOCK_SCHEMA_ID, MOCK_NAME);

//             expect(version).toBe(7n);
//             expect(clients.publicClient.readContract).toHaveBeenCalledWith(
//                 expect.objectContaining({
//                     functionName: "getVersion",
//                     args: [OWNER_ADDRESS, MOCK_SCHEMA_ID, MOCK_NAME],
//                 })
//             );
//         });
//     });

//     // ── resourceId ────────────────────────────────────────────────────────────

//     describe("resourceId", () => {
//         it("calls the contract resourceId view and returns the result", async () => {
//             const mockId: Hex = "0xbeef000000000000000000000000000000000000000000000000000000000000";
//             const clients = makeClients({ readContractImpl: () => mockId });

//             const result = await makeRegistry(clients).resourceId(OWNER_ADDRESS, MOCK_SCHEMA_ID, MOCK_NAME);

//             expect(result).toBe(mockId);
//             expect(clients.publicClient.readContract).toHaveBeenCalledWith(
//                 expect.objectContaining({
//                     functionName: "resourceId",
//                     args: [OWNER_ADDRESS, MOCK_SCHEMA_ID, MOCK_NAME],
//                 })
//             );
//         });
//     });

//     // ── resourceIdLocal ───────────────────────────────────────────────────────

//     describe("resourceIdLocal", () => {
//         it("matches the contract derivation: keccak256(owner ++ schema_id ++ keccak256(name))", () => {
//             const nameHash = keccak256(new TextEncoder().encode(MOCK_NAME) as Uint8Array<ArrayBuffer>);
//             const expected = keccak256(
//                 encodePacked(
//                     ["address", "bytes32", "bytes32"],
//                     [OWNER_ADDRESS, MOCK_SCHEMA_ID, nameHash],
//                 )
//             );

//             expect(DataSourceRegistry.resourceIdLocal(OWNER_ADDRESS, MOCK_SCHEMA_ID, MOCK_NAME)).toBe(expected);
//         });

//         it("produces different ids for different names", () => {
//             const a = DataSourceRegistry.resourceIdLocal(OWNER_ADDRESS, MOCK_SCHEMA_ID, "track-1");
//             const b = DataSourceRegistry.resourceIdLocal(OWNER_ADDRESS, MOCK_SCHEMA_ID, "track-2");
//             expect(a).not.toBe(b);
//         });

//         it("produces different ids for different schemas", () => {
//             const schemaB: Hex = "0xbebebebe00000000000000000000000000000000000000000000000000000000";
//             const a = DataSourceRegistry.resourceIdLocal(OWNER_ADDRESS, MOCK_SCHEMA_ID, MOCK_NAME);
//             const b = DataSourceRegistry.resourceIdLocal(OWNER_ADDRESS, schemaB, MOCK_NAME);
//             expect(a).not.toBe(b);
//         });

//         it("is deterministic", () => {
//             expect(DataSourceRegistry.resourceIdLocal(OWNER_ADDRESS, MOCK_SCHEMA_ID, MOCK_NAME))
//                 .toBe(DataSourceRegistry.resourceIdLocal(OWNER_ADDRESS, MOCK_SCHEMA_ID, MOCK_NAME));
//         });

//         it("makes no RPC calls", () => {
//             const clients = makeClients();
//             DataSourceRegistry.resourceIdLocal(OWNER_ADDRESS, MOCK_SCHEMA_ID, MOCK_NAME);
//             expect(clients.publicClient.readContract).not.toHaveBeenCalled();
//         });
//     });

//     // ── hashName ──────────────────────────────────────────────────────────────

//     describe("hashName", () => {
//         it("produces the keccak256 of the UTF-8 encoded name", () => {
//             const registry = makeRegistry();
//             const expected = keccak256(new TextEncoder().encode(MOCK_NAME) as Uint8Array<ArrayBuffer>);
//             expect(registry.hashName(MOCK_NAME)).toBe(expected);
//         });

//         it("is consistent with resourceIdLocal's internal hash", () => {
//             const registry = makeRegistry();
//             const nameHash = registry.hashName(MOCK_NAME);
//             const fromLocal = DataSourceRegistry.resourceIdLocal(OWNER_ADDRESS, MOCK_SCHEMA_ID, MOCK_NAME);
//             const manual = keccak256(
//                 encodePacked(["address", "bytes32", "bytes32"], [OWNER_ADDRESS, MOCK_SCHEMA_ID, nameHash])
//             );
//             expect(fromLocal).toBe(manual);
//         });
//     });

//     // ── waitForTransaction ────────────────────────────────────────────────────

//     describe("waitForTransaction", () => {
//         it("delegates to publicClient.waitForTransactionReceipt", async () => {
//             const receipt = makeMockReceipt();
//             const clients = makeClients({ waitForTransactionReceiptImpl: () => receipt });
//             const result = await makeRegistry(clients).waitForTransaction(MOCK_TX_HASH);
//             expect(result).toEqual(receipt);
//             expect(clients.publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: MOCK_TX_HASH });
//         });
//     });
// });