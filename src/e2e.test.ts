import { describe, it, expect, beforeAll } from "vitest";
import { createPublicClient, createWalletClient, http, parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { Identity } from "@semaphore-protocol/identity";
import { TestBed } from "./test/index.js";
import { SchemaDefinition } from "./roles/schema/types.js";
import { SettlementRegistry } from "./registries/settlement-registry/index.js";
import { PublishRecord } from "./roles/publisher/types.js";

// TODO
// EMPTY WALLET 0x7e69fd5bb5aa5971e2541fb40512490fd4c6cac97589f9ce538e521f4815fac8
// both of the ones below are funded
const SK = (process.env.DELEGATOR_ETH_PRIVATE_KEY ?? "0xde0e6c1c331fcd8692463d6ffcf20f9f2e1847264f7a3f578cf54f62f05196cb") as Hex;
// in practice should be generate f using eip 5564?
const BURNER_SK = (process.env.DELEGATEE_ETH_PRIVATE_KEY ?? "0xcbd236ee5a2fd07e8c9ef9198a23d869b7be792ca1ad76b35a6c67453839aaba") as Hex;
// setup env vars
const RPC_URL = process.env.RPC_URL ?? "https://sepolia-rollup.arbitrum.io/rpc";

// The owner of the resource (receives USDC, needs ETH)
const OWNER_KEY = (process.env.DELEGATOR_ETH_PRIVATE_KEY ?? "0xde0e6c1c331fcd8692463d6ffcf20f9f2e1847264f7a3f578cf54f62f05196cb") as Hex;
// The faciltiator's key (only needs ETH)
const FACILITATOR_KEY = SK
// The party who actually wants access to the resource (needs nothing)
const BUYER_KEY = SK
// an ephemeral burner key ONLY NEEDS USDC
const BURNER_KEY = BURNER_SK

const PINATA_JWT = process.env.PINATA_JWT ?? "";
const PINATA_GW = process.env.PINATA_GATEWAY ?? "";
// Fangorn Contracts
const SETTLEMENT_REGISTRY_ADDRESS = (process.env.SETTLEMENT_REGISTRY_ADDRESS ?? "0x7c261c222beaa4f866e7f33de7704906d1245a2a") as Address;
const DATA_SOURCE_REGISTRY_ADDRESS = (process.env.DATA_SOURCE_REGISTRY_ADDRESS ?? "0x3941c7d50caa56f7f676554bc4e78d77aaf27ebb") as Address;
const SCHEMA_REGISTRY_ADDRESS = (process.env.SCHEMA_REGISTRY_ADDRESS ?? "0x49ab3d52b997e63ad56c91178df48263fd80b2dc") as Address;
// USDC setup
const USDC_ADDRESS = (process.env.USDC_ADDRESS ?? "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d") as Address;
const USDC_AMOUNT = 1n;
const USDC_DOMAIN = "USD Coin";
const CAIP_2 = parseInt(process.env.CAIP2!) ?? 421614;

const CHAIN = arbitrumSepolia;

// In production derive stealthAddress via EIP-5564; fixed for tests
const STEALTH_ADDRESS = privateKeyToAccount(BURNER_SK).address;
// const STEALTH_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as `0x${string}`;

const hasIpfs = !!PINATA_JWT;

function makeWallet(key: Hex) {
	return createWalletClient({
		account: privateKeyToAccount(key),
		chain: CHAIN,
		transport: http(RPC_URL),
	});
}

const publicClient = createPublicClient({ chain: CHAIN, transport: http(RPC_URL) });

// async function waitFor(hash: Hex) {
// 	return publicClient.waitForTransactionReceipt({ hash });
// }

const MUSIC_SCHEMA: SchemaDefinition = {
	title: { "@type": "string" },
	artist: { "@type": "string" },
	audio: { "@type": "encrypted", gadget: "settled" },
};

const ENCRYPTED_FIELD = "audio";
const PINATA_GATEWAY = process.env.PINATA_GW ?? "https://gateway.pinata.cloud";

const TEST_RECORDS: PublishRecord[] = [
		{
			tag: "track-01",
			fields: {
				title: "Track One",
				artist: "Alice",
				audio: { data: new Uint8Array([1, 2, 3, 4, 5]), fileType: "audio/mp3" },
			},
		},
	{
		tag: "track-02",
		fields: {
			title: "Track Two",
			artist: "Alice",
			audio: { data: new Uint8Array([6, 7, 8, 9, 10]), fileType: "audio/mp3" },
		},
	},
];

describe("Fangorn E2E", () => {
	let testbed: TestBed;
	let ownerAddress: Address;

	beforeAll(async () => {
		testbed = await TestBed.init(
			makeWallet(OWNER_KEY),
			makeWallet(BUYER_KEY),
			PINATA_JWT,
			PINATA_GW,
			DATA_SOURCE_REGISTRY_ADDRESS,
			SCHEMA_REGISTRY_ADDRESS,
			SETTLEMENT_REGISTRY_ADDRESS,
			USDC_ADDRESS,
			USDC_DOMAIN,
			RPC_URL,
			"arbitrumSepolia",
			CHAIN.id,
			OWNER_KEY,   // ← enables agent0-sdk / ERC-8004 for schema owner role
		);

		ownerAddress = privateKeyToAccount(OWNER_KEY).address;
	});

	// 1. Schema owner: register agent

	describe.skipIf(!hasIpfs)("Alice — schema owner", () => {
		let schemaName: string;
		let agentId: string;
		let schemaId: Hex;
		let nullifierHash: bigint;
		// smallest nonzero USDC price (0.000001)
		let price = 1n;

		// it("registers an ERC-8004 agent identity", async () => {
		// 	const result = await testbed.registerAgent({
		// 		name: "Fangorn Music Curator",
		// 		description: "Discovers and curates encrypted music datasources",
		// 		// a2aUrl and mcpEndpoint omitted — not required for tests
		// 	});

		// 	expect(result.agentId).toBeTruthy();
		// 	agentId = result.agentId;
		// });

		it("registers a schema on-chain", async () => {
			schemaName = `fangorn.music.v1.${Date.now()}`
			// todo: register agent
			agentId = ""
			schemaId = await testbed.registerSchema(
				schemaName,
				MUSIC_SCHEMA,
				agentId,
			);

			expect(schemaId).toMatch(/^0x[0-9a-f]{64}$/i);
		}, 30_000); // 30s timeout to wait for pinata

		it("can fetch the registered schema by id", async () => {
			const schema = await testbed
				.getDelegatorFangorn()
				.schema.get(schemaName);

			expect(schema).toBeDefined();
			expect(schema!.definition).toMatchObject(MUSIC_SCHEMA);
			expect(schema!.agentId).toBe(agentId);
			expect(schema!.owner.toLowerCase()).toBe(ownerAddress.toLowerCase());
		});

		describe("Publisher", () => {
			it("uploads multiple files and publishes a manifest", async () => {
				const manifestCid = await testbed.fileUpload(
					TEST_RECORDS,
					MUSIC_SCHEMA,
					schemaId,
					PINATA_GATEWAY,
					price
				);

				expect(manifestCid).toBeTruthy();
			}, 60_000); // Lit action IPFS upload on first call so we need to wait for pinata

			it("manifest exists on-chain after upload", async () => {
				const exists = await testbed.checkManifestExists(ownerAddress, schemaId);
				expect(exists).toBe(true);
			});

			it("both entries are present in the manifest", async () => {
				for (const record of TEST_RECORDS) {
					const exists = await testbed.checkEntryExists(ownerAddress, schemaId, record.tag);
					expect(exists).toBe(true);
				}
			});

			// it("owner can decrypt their own data without settlement", async () => {
			// 	for (const record of TEST_RECORDS) {
			// 		const data = await testbed.tryDecryptDelegator(ownerAddress, schemaId, record.tag, ENCRYPTED_FIELD);
			// 		expect(data).toBeInstanceOf(Uint8Array);
			// 		expect(data.length).toBeGreaterThan(0);
			// 	}
			// });

			describe("Consumer", () => {
				let buyerIdentity: Identity;
				const tag = TEST_RECORDS[0].tag;

				beforeAll(() => {
					buyerIdentity = new Identity();
				});

				it("cannot decrypt before purchasing", async () => {
					// no nullifier
					await expect(
						testbed.tryDecrypt(
							ownerAddress,
							0n,
							SK,
							schemaId, tag,
							ENCRYPTED_FIELD,
							RPC_URL,
							buyerIdentity,
							true
						),
					).rejects.toThrow("not registered");
				});

				it("cannot decrypt when identity is missing and settlement is required", async () => {
					await expect(
						testbed.tryDecrypt(
							ownerAddress, 0n,
							SK,
							schemaId, 
							tag,
							ENCRYPTED_FIELD,
							RPC_URL,
							undefined,
							true
						),
					).rejects.toThrow("identity is required");
				});

				it("Phase 1: purchase - joins the Semaphore group", async () => {

					// prepare register 
					const transferWithAuthPayload = await testbed.prepareRegister(
						BURNER_KEY,
						ownerAddress,
						USDC_AMOUNT
					);

					const txHash = await testbed.register(
						ownerAddress,
						schemaId,
						tag,
						buyerIdentity.commitment,
						FACILITATOR_KEY,
						transferWithAuthPayload,
					);

					expect(txHash).toMatch(/^0x[0-9a-f]{64}$/i);
					const registered = await testbed
						.getSettlementRegistry()
						.isRegistered(
							SettlementRegistry.deriveResourceId(ownerAddress, schemaId, tag),
							buyerIdentity.commitment,
						);
					expect(registered).toBe(true);
				}, 30_000);

				// TODO
				// it("Phase 1: reverts on double registration with same identity", async () => {
				// 	await expect(
				// 		testbed.register(ownerAddress, schemaId, tag, buyerIdentity, BURNER_KEY, USDC_AMOUNT),
				// 	).rejects.toThrow();
				// });

				it("Phase 2: claim - proves membership and fires access hook", async () => {
					// prepare settle
					const payload = await testbed.prepareSettle(
						ownerAddress,
						schemaId,
						tag,
						buyerIdentity,
						STEALTH_ADDRESS
					);

					// settle
					const { txHash, nullifier } = await testbed.settle(
						ownerAddress,
						schemaId,
						tag,
						SK,
						payload
					);
					nullifierHash = nullifier;
					expect(txHash).toMatch(/^0x[0-9a-f]{64}$/i);
					// verify that the settlement is true
					const resourceId = SettlementRegistry.deriveResourceId(ownerAddress, schemaId, tag);
					const isSettled = await testbed.getDelegateeFangorn().getSettlementRegistry()
						.isSettled(STEALTH_ADDRESS, resourceId);

					expect(isSettled).toBe(true);
				});

				// it("Phase 2: reverts on double-settle (nullifier already used)", async () => {
				// 	await expect(
				// 		testbed.settle(ownerAddress, schemaId, tag, buyerIdentity, STEALTH_ADDRESS, BUYER_KEY),
				// 	).rejects.toThrow();
				// });

				// it("Phase 2: reverts if identity was never registered", async () => {
				// 	const stranger = new Identity();
				// 	await expect(
				// 		testbed.settle(ownerAddress, schemaId, tag, stranger, STEALTH_ADDRESS, BUYER_KEY),
				// 	).rejects.toThrow();
				// });

				it("decrypt — buyer can read the file after full settlement", async () => {
					const data = await testbed.tryDecrypt(
						ownerAddress,
						nullifierHash,
						BURNER_KEY,
						schemaId,
						tag,
						ENCRYPTED_FIELD,
						RPC_URL,
						buyerIdentity,
						true,
					);
					expect(data).toBeInstanceOf(Uint8Array);
					expect(data.length).toBeGreaterThan(0);
				}, 30_000);

				// it("a second buyer can independently purchase and decrypt", async () => {
				// 		const identity2 = new Identity();

				// 		await testbed.register(
				// 			ownerAddress, schemaId, tag, identity2, BURNER_KEY, USDC_AMOUNT,
				// 		);

				// 		await testbed.settle(
				// 			ownerAddress, schemaId, tag, identity2, STEALTH_ADDRESS, BUYER_KEY,
				// 		);

				// 		// q: idt this works: need a new nullifier
				// 		const data = await testbed.tryDecrypt(
				// 			ownerAddress, nullifierHash, schemaId, tag, ENCRYPTED_FIELD, identity2, true,
				// 		);
				// 		expect(data).toBeInstanceOf(Uint8Array);
				// 		expect(data.length).toBeGreaterThan(0);
				// 	}, 30_000);
			});
		});
	});

	// ── deriveResourceId (no IPFS required) ──────────────────────────────────

	// describe("SettlementRegistry.deriveResourceId", () => {
	// 	const STUB_SCHEMA_ID = "0x0000000000000000000000000000000000000000000000000000000000000001" as Hex;
	// 	const TAG = "derive-test";

	// 	it("is deterministic for the same (owner, schemaId, tag)", () => {
	// 		const a = SettlementRegistry.deriveResourceId(ownerAddress, STUB_SCHEMA_ID, TAG);
	// 		const b = SettlementRegistry.deriveResourceId(ownerAddress, STUB_SCHEMA_ID, TAG);
	// 		expect(a).toBe(b);
	// 	});

	// 	it("differs for different tags", () => {
	// 		const a = SettlementRegistry.deriveResourceId(ownerAddress, STUB_SCHEMA_ID, "tag-a");
	// 		const b = SettlementRegistry.deriveResourceId(ownerAddress, STUB_SCHEMA_ID, "tag-b");
	// 		expect(a).not.toBe(b);
	// 	});

	// 	it("differs for different schemaIds", () => {
	// 		const schemaA = "0x0000000000000000000000000000000000000000000000000000000000000001" as Hex;
	// 		const schemaB = "0x0000000000000000000000000000000000000000000000000000000000000002" as Hex;
	// 		const a = SettlementRegistry.deriveResourceId(ownerAddress, schemaA, TAG);
	// 		const b = SettlementRegistry.deriveResourceId(ownerAddress, schemaB, TAG);
	// 		expect(a).not.toBe(b);
	// 	});

	// 	it("differs for different owners", () => {
	// 		// Use hardcoded addresses so this pure unit test never depends on env vars
	// 		const addr1 = "0x0000000000000000000000000000000000000001" as Address;
	// 		const addr2 = "0x0000000000000000000000000000000000000002" as Address;
	// 		const a = SettlementRegistry.deriveResourceId(addr1, STUB_SCHEMA_ID, TAG);
	// 		const b = SettlementRegistry.deriveResourceId(addr2, STUB_SCHEMA_ID, TAG);
	// 		expect(a).not.toBe(b);
	// 	});
	// });
});