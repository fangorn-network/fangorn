import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { x25519 } from "@noble/curves/ed25519";
import { bytesToHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { repoId } from "../contracts/data-registry/index.js";
import {
	WHOLE_REPO,
	recordKey,
	registerNonce,
	subjectOf,
	termsFromJson,
	termsToJson,
	type TermsJson,
} from "../contracts/settlement-registry/index.js";
import {
	decryptField,
	deriveRecordKey,
	makeDeposit,
	openField,
	newRepoKey,
	requestKey,
	sealField,
	statement,
	type AccessRequest,
	type Deposit,
	type FieldHandle,
	type PaidScope,
} from "../crypto/paid.js";
import type { Fangorn } from "../fangorn.js";
import { sealRecords } from "../cli/sell.js";
import { testKeyServer } from "../test/key-server.js";
import { chainNetwork, skipChain, type ChainNetwork } from "../test/testbed.js";

// Selling a record, end to end on anvil: the publisher seals a field, deposits
// the repo key and commits the record with its signed terms; a buyer registers
// and settles on the SettlementRegistry; a key server (testKeyServer over HTTP,
// reading canRead from the chain) releases the key; the buyer decrypts.
// USDC and Semaphore are the contracts repo's mocks.

const REFERRER = "0x0000000000000000000000000000000000C0FFEE" as Address;
const PRICE = 10_000n;
const enc = new TextEncoder();
const dec = new TextDecoder();

describe.skipIf(skipChain)("paid records (contracts on anvil)", () => {
	let net: ChainNetwork;
	let server: Server;
	let keyServerUrl: string;
	const ksSecret = x25519.utils.randomSecretKey();

	beforeAll(async () => {
		net = await chainNetwork();
		const ks = await net.client();
		const chainId = net.config.chain.id;
		const registry = ks.getSettlementRegistry();
		server = createServer((req, res) => {
			if (req.url === "/pubkey") {
				res
					.writeHead(200, { "Content-Type": "application/json" })
					.end(
						JSON.stringify({
							pubkey: bytesToHex(x25519.getPublicKey(ksSecret)),
						}),
					);
				return;
			}
			let body = "";
			req.on("data", (c: Buffer) => (body += c.toString()));
			req.on("end", () => {
				testKeyServer(JSON.parse(body) as AccessRequest, {
					secret: ksSecret,
					chainId,
					registry: registry.getAddress(),
					canRead: (r, p, repo, key) => registry.canRead(r, p, repo, key),
				}).then(
					async (out) =>
						res
							.writeHead(out.status, { "Content-Type": "application/json" })
							.end(await out.text()),
					(e: unknown) => res.writeHead(500).end(String(e)),
				);
			});
		});
		await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
		keyServerUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
	}, 180_000);

	afterAll(() => {
		server.close();
		net.stop();
	});

	/** A publisher's repo with two records for sale, `a` and `b`, each with a paid `body`. */
	async function publish(name: string) {
		const pub = await net.client();
		await pub.initRepo(name);
		const settlement = pub.getSettlementRegistry();
		const repo = repoId(name);
		const scope: PaidScope = {
			chainId: net.config.chain.id,
			registry: settlement.getAddress(),
			publisher: pub.getAddress(),
			repo,
			generation: await settlement.generationOf(pub.getAddress(), repo),
		};
		const kRepo = newRepoKey();
		const deposit = makeDeposit({
			kRepo,
			keyServerPubkey: x25519.getPublicKey(ksSecret),
			keyServer: keyServerUrl,
			scope,
		});
		const records = await Promise.all(
			["a", "b"].map(async (id) => ({
				id,
				type: "note",
				payload: {
					title: `note ${id}`,
					body: await sealField({
						plaintext: enc.encode(`the body of ${id}`),
						kRepo,
						scope,
						key: recordKey(id),
						field: "body",
						storage: pub.getStorage(),
					}),
					"@terms": termsToJson(
						await settlement.signTerms({
							repo,
							key: recordKey(id),
							price: PRICE,
							shareBps: 500,
							deadline: 2_000_000_000n,
						}),
					),
				},
			})),
		);
		await pub.uploadBatch(name, [
			...records,
			{
				id: `@deposit/${deposit.generation}`,
				type: "deposit",
				payload: deposit as unknown as Record<string, unknown>,
			},
		]);
		return { pub, repo, scope };
	}

	/** What a buyer reads from the chain and storage: the record and the repo's deposit. */
	async function read(pub: Fangorn, name: string, id: string) {
		const record = await pub.engine.readRecord(pub.getAddress(), name, id);
		const payload = record?.payload as unknown as {
			body: FieldHandle;
			"@terms": TermsJson;
		};
		const deposit = (
			await pub.engine.readRecord(
				pub.getAddress(),
				name,
				`@deposit/${payload.body.generation}`,
			)
		)?.payload as unknown as Deposit;
		return { payload, deposit };
	}

	/** Register (paying with the mock USDC) and settle `subject`'s terms for `reader`. */
	async function buy(
		buyer: Fangorn,
		json: TermsJson,
		reader: Address,
		key: Hex,
	) {
		const { terms, signature } = termsFromJson(json);
		const s = buyer.getSettlementRegistry();
		const subject = subjectOf(terms.publisher, terms.repo, key);
		const commitment = BigInt(generatePrivateKey());
		const salt = generatePrivateKey();
		await s.register({
			terms,
			signature,
			commitment,
			referrer: REFERRER,
			salt,
			payment: {
				from: buyer.getAddress(),
				value: terms.price,
				validAfter: 0n,
				validBefore: 2_000_000_000n,
				nonce: registerNonce(subject, commitment, REFERRER, salt),
				v: 27,
				r: `0x${"00".repeat(32)}`,
				s: `0x${"00".repeat(32)}`,
			},
		});
		await s.settle({
			subject,
			reader,
			merkleTreeDepth: 1n,
			merkleTreeRoot: 1n,
			nullifier: BigInt(generatePrivateKey()),
			points: [0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n],
		});
	}

	it("a buyer pays for a record and decrypts it; nothing before, nothing else", async () => {
		const { pub } = await publish("shop");
		const buyer = await net.client();
		const reader = privateKeyToAccount(generatePrivateKey());
		const a = await read(pub, "shop", "a");
		const b = await read(pub, "shop", "b");
		const open = (r: typeof a, id: string) =>
			openField({
				handle: r.payload.body,
				deposit: r.deposit,
				key: recordKey(id),
				field: "body",
				signer: reader,
				storage: buyer.getStorage(),
			});

		await expect(open(a, "a")).rejects.toThrow(/403/);

		await buy(buyer, a.payload["@terms"], reader.address, recordKey("a"));
		await expect(open(a, "a").then((x) => dec.decode(x))).resolves.toBe(
			"the body of a",
		);
		await expect(open(b, "b")).rejects.toThrow(/403/);

		// The publisher got the price less the referrer's 5%.
		const paid = (who: Address) =>
			net.chain.readContract({
				address: net.usdc,
				abi: [
					{
						type: "function",
						name: "balanceOf",
						stateMutability: "view",
						inputs: [{ type: "address" }],
						outputs: [{ type: "uint256" }],
					},
				],
				functionName: "balanceOf",
				args: [who],
			});
		expect(await paid(pub.getAddress())).toBe(PRICE - PRICE / 20n);
		expect(await paid(REFERRER)).toBe(PRICE / 20n);
	}, 120_000);

	it("a whole-repo buyer gets the repo key and opens every record", async () => {
		const { pub, repo, scope } = await publish("bundle");
		const settlement = pub.getSettlementRegistry();
		const whole = termsToJson(
			await settlement.signTerms({
				repo,
				key: WHOLE_REPO,
				price: PRICE,
				shareBps: 500,
				deadline: 2_000_000_000n,
			}),
		);
		const buyer = await net.client();
		const reader = privateKeyToAccount(generatePrivateKey());
		await buy(buyer, whole, reader.address, WHOLE_REPO);

		const { deposit } = await read(pub, "bundle", "a");
		const kRepo = await requestKey({
			deposit,
			key: WHOLE_REPO,
			signer: reader,
		});
		const stmt = statement(scope);
		for (const id of ["a", "b"]) {
			const { payload } = await read(pub, "bundle", id);
			const ct = await buyer.getStorage().getFile(payload.body.cid);
			expect(
				dec.decode(
					decryptField(
						deriveRecordKey(kRepo, stmt, recordKey(id)),
						ct,
						stmt,
						recordKey(id),
						"body",
					),
				),
			).toBe(`the body of ${id}`);
		}
	}, 120_000);

	it("the publisher recovers its repo key from the key server and seals more", async () => {
		const { pub, scope } = await publish("more");
		const { deposit } = await read(pub, "more", "a");
		// The publisher's wallet signs; no private key is handled.
		const wallet = pub.getWalletClient();
		const kRepo = await requestKey({
			deposit,
			key: WHOLE_REPO,
			signer: {
				signMessage: (m) =>
					wallet.signMessage({
						account: wallet.account ?? pub.getAddress(),
						...m,
					}),
			},
		});

		const handle = await sealField({
			plaintext: enc.encode("c"),
			kRepo,
			scope,
			key: recordKey("c"),
			field: "body",
			storage: pub.getStorage(),
		});
		const stmt = statement(scope);
		const ct = await pub.getStorage().getFile(handle.cid);
		// The same key as the records already sold: a buyer of the repo opens this one too.
		const kA = deriveRecordKey(kRepo, stmt, recordKey("a"));
		const a = await read(pub, "more", "a");
		expect(
			dec.decode(
				decryptField(
					kA,
					await pub.getStorage().getFile(a.payload.body.cid),
					stmt,
					recordKey("a"),
					"body",
				),
			),
		).toBe("the body of a");
		expect(
			dec.decode(
				decryptField(
					deriveRecordKey(kRepo, stmt, recordKey("c")),
					ct,
					stmt,
					recordKey("c"),
					"body",
				),
			),
		).toBe("c");
	}, 120_000);

	it("a takedown stops the key server releasing the key", async () => {
		const { pub, repo } = await publish("gone");
		const buyer = await net.client();
		const reader = privateKeyToAccount(generatePrivateKey());
		const a = await read(pub, "gone", "a");
		await buy(buyer, a.payload["@terms"], reader.address, recordKey("a"));
		await pub.getSettlementRegistry().setDisabled(repo, recordKey("a"), true);

		await expect(
			openField({
				handle: a.payload.body,
				deposit: a.deposit,
				key: recordKey("a"),
				field: "body",
				signer: reader,
				storage: buyer.getStorage(),
			}),
		).rejects.toThrow(/403/);
	}, 120_000);

	it("sealRecords: one call makes records sellable, and a second reuses the deposit", async () => {
		const pub = await net.client();
		await pub.initRepo("sealed");
		const o = {
			fields: ["body"],
			price: PRICE,
			shareBps: 500,
			deadline: 2_000_000_000n,
			keyServer: keyServerUrl,
		};
		const first = await sealRecords(
			pub,
			"sealed",
			[
				{
					id: "a",
					type: "note",
					payload: { title: "a", body: { text: "the body of a" } },
				},
				{ id: "free", type: "note", payload: { title: "free" } },
			],
			o,
		);
		expect(first.map((r) => r.id)).toEqual(["@deposit/0", "a", "free"]);
		expect(first[2].payload).toEqual({ title: "free" });
		await pub.uploadBatch("sealed", first);

		const second = await sealRecords(
			pub,
			"sealed",
			[{ id: "b", type: "note", payload: { body: "b" } }],
			o,
		);
		expect(second.map((r) => r.id)).toEqual(["b"]);
		await pub.uploadBatch("sealed", second);

		const buyer = await net.client();
		const reader = privateKeyToAccount(generatePrivateKey());
		const a = await read(pub, "sealed", "a");
		await buy(buyer, a.payload["@terms"], reader.address, recordKey("a"));
		const opened = await openField({
			handle: a.payload.body,
			deposit: a.deposit,
			key: recordKey("a"),
			field: "body",
			signer: reader,
			storage: buyer.getStorage(),
		});
		expect(JSON.parse(dec.decode(opened))).toEqual({ text: "the body of a" });

		// b was sealed under the same deposit: the publisher opens it with its own key.
		const b = await read(pub, "sealed", "b");
		const wallet = pub.getWalletClient();
		const signer = {
			signMessage: (m: { message: { raw: Hex } }) =>
				wallet.signMessage({
					account: wallet.account ?? pub.getAddress(),
					...m,
				}),
		};
		const ob = await openField({
			handle: b.payload.body,
			deposit: b.deposit,
			key: recordKey("b"),
			field: "body",
			signer,
			storage: pub.getStorage(),
		});
		expect(JSON.parse(dec.decode(ob))).toBe("b");
	}, 120_000);

	it("a new generation voids the old terms", async () => {
		const { pub, repo } = await publish("gen");
		const a = await read(pub, "gen", "a");
		await pub.getSettlementRegistry().raiseGeneration(repo);
		const buyer = await net.client();
		await expect(
			buy(buyer, a.payload["@terms"], buyer.getAddress(), recordKey("a")),
		).rejects.toThrow(/StaleTerms/);
	}, 120_000);
});
