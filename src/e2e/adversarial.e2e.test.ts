import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { x25519 } from "@noble/curves/ed25519";
import {
	bytesToHex,
	hashTypedData,
	maxUint256,
	type Address,
	type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { identity } from "multiformats/hashes/identity";
import { sha256 } from "multiformats/hashes/sha2";
import {
	DATA_REGISTRY_ABI,
	EMPTY_MMR,
	logLeaf,
	mmrAppend,
	mmrRoot,
	repoId,
	ZERO_HEAD,
	type CommitUpdate,
} from "../contracts/index.js";
import { SETTLEMENT_REGISTRY_ABI } from "../contracts/settlement-registry/abi.js";
import {
	TERMS_TYPES,
	WHOLE_REPO,
	recordKey,
	registerNonce,
	settlementDomain,
	subjectOf,
	type Terms,
} from "../contracts/settlement-registry/index.js";
import {
	deriveRecordKey,
	makeDeposit,
	newRepoKey,
	requestKey,
	statement,
	type AccessRequest,
	type PaidScope,
} from "../crypto/paid.js";
import { commitHead } from "../engine/index.js";
import type { Fangorn, RepoChange } from "../fangorn.js";
import { testKeyServer } from "../test/key-server.js";
import { chainNetwork, skipChain, type ChainNetwork } from "../test/testbed.js";

// Audit (adversarial): properties that only show across the SDK/contract
// boundary, on a fresh anvil with the contracts built from FANGORN_CONTRACTS_DIR.

const junk = (): Hex => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));

/** A CID whose binary form is exactly `len` bytes (identity multihash), to walk CBOR's byte-string ladder. */
function cidOfLength(len: number): CID {
	for (let d = Math.max(0, len - 8); d <= len; d++) {
		const cid = CID.createV1(raw.code, identity.digest(new Uint8Array(d)));
		if (cid.bytes.length === len) return cid;
	}
	throw new Error(`no identity CID of ${String(len)} bytes`);
}

describe.skipIf(skipChain)("adversarial (contracts on anvil)", () => {
	let net: ChainNetwork;
	beforeAll(async () => {
		net = await chainNetwork();
	}, 180_000);
	afterAll(() => net.stop());

	const chainHead = (u: CommitUpdate) =>
		net.chain.readContract({
			address: net.config.dataRegistryContractAddress,
			abi: DATA_REGISTRY_ABI,
			functionName: "commitHead",
			args: [u.repo, BigInt(u.epoch), u.parent, u.diff, u.root, u.car],
		});

	describe("commitHead parity: SDK dag-cbor vs the contract's hand-rolled CBOR", () => {
		const base = async (): Promise<CommitUpdate> => ({
			repo: "r",
			epoch: 1,
			parent: junk(),
			diff: junk(),
			root: junk(),
			car: bytesToHex(
				CID.createV1(raw.code, await sha256.digest(new Uint8Array([1]))).bytes,
			),
		});

		const names: [string, string][] = [
			["23 bytes", "a".repeat(23)],
			["24 bytes", "a".repeat(24)],
			["255 bytes", "a".repeat(255)],
			["256 bytes", "a".repeat(256)],
			["65535 bytes", "a".repeat(65535)],
			["65536 bytes", "a".repeat(65536)],
			["2-byte utf-8 x12 (24 bytes)", "é".repeat(12)],
			["4-byte utf-8", "🌳 forest"],
			["NFC", "café"],
			["NFD", "café"],
			["slash and NUL", "a/b\u0000c"],
		];
		it.each(names)("repo %s", async (_, repo) => {
			const u = { ...(await base()), repo };
			expect(await commitHead(u)).toBe(await chainHead(u));
		});

		it.each([0, 23, 24, 255, 256, 65535, 65536, 2 ** 32 - 1, 2 ** 32])(
			"epoch %d",
			async (epoch) => {
				const u = { ...(await base()), epoch };
				expect(await commitHead(u)).toBe(await chainHead(u));
			},
		);

		it("a root commit (zero parent)", async () => {
			const u = { ...(await base()), parent: ZERO_HEAD };
			expect(await commitHead(u)).toBe(await chainHead(u));
		});

		it.each([22, 23, 24, 254, 255, 256, 65534, 65535])(
			"car CID of %d bytes",
			async (len) => {
				const u = {
					...(await base()),
					car: bytesToHex(cidOfLength(len).bytes),
				};
				expect(await commitHead(u)).toBe(await chainHead(u));
			},
		);

		it("a lone surrogate in the repo name (not valid UTF-16)", async () => {
			const u = { ...(await base()), repo: "x\ud800" };
			// Record, don't assume: viem encodes it as U+FFFD; does dag-cbor?
			const [sdk, chain] = [await commitHead(u), await chainHead(u)];
			const sdkFffd = await commitHead({ ...u, repo: "x�" });
			expect({
				matchesChain: sdk === chain,
				chainIsFffd: chain === sdkFffd,
			}).toEqual({
				matchesChain: true,
				chainIsFffd: true,
			});
		});
	});

	it("repo ids: a non-ASCII, max-length repo publishes, reads back and lists by name", async () => {
		const pub = await net.client();
		const reader = await net.client();
		// 256 UTF-16 units (the SDK's cap) but 512 bytes on chain
		const repo = "é".repeat(256);
		await pub.initRepo(repo);
		await pub.upload(repo, { x: 1 }, "t", "a");
		const { contents } = await reader.readRepo(pub.getAddress(), repo);
		expect(contents.records.map((r) => r.id)).toEqual(["a"]);
		const [pos, head] = await net.chain.readContract({
			address: net.config.dataRegistryContractAddress,
			abi: DATA_REGISTRY_ABI,
			functionName: "getHead",
			args: [pub.getAddress(), repoId(repo)],
		});
		expect(pos).toBe(2n);
		expect(head).toBe(
			await reader.getRegistry().head({ publisher: pub.getAddress(), repo }),
		);
		const listed = await reader.repos({ owner: pub.getAddress() });
		expect(listed.map((l) => l.repo)).toEqual([repo]);
	}, 60_000);

	it("updateBySig: a signature made by the SDK is accepted from a relayer, once", async () => {
		const pub = await net.client();
		const relayer = await net.client();
		const repo = "🌳/relayed";
		const { commitCid } = await pub.commit({ repo, records: [] });
		const signed = await pub.signPush(repo, commitCid);
		await relayer.relayPush(signed);
		expect(
			(
				await relayer
					.getRegistry()
					.headAt({ publisher: pub.getAddress(), repo })
			).pos,
		).toBe(1);
		// replay: the parent is no longer the head
		await expect(relayer.relayPush(signed)).rejects.toThrow(
			/StaleStateRoot|revert/,
		);
		// the signature does not move another repo
		await expect(
			relayer.relayPush({
				...signed,
				update: { ...signed.update, repo: "other" },
			}),
		).rejects.toThrow(/BadSignature|revert/);
	}, 60_000);

	it("hashTerms: the contract's digest is the one the SDK signs, at the type bounds", async () => {
		const settlement = net.config.settlementRegistryContractAddress;
		if (!settlement) throw new Error("no SettlementRegistry");
		const t: Terms = {
			publisher: privateKeyToAccount(generatePrivateKey()).address,
			repo: repoId("é"),
			key: recordKey("a"),
			price: maxUint256,
			shareBps: 10_000,
			generation: 2n ** 64n - 1n,
			deadline: 2n ** 64n - 1n,
		};
		const onChain = await net.chain.readContract({
			address: settlement,
			abi: SETTLEMENT_REGISTRY_ABI,
			functionName: "hashTerms",
			args: [t],
		});
		expect(
			hashTypedData({
				domain: settlementDomain(net.config.chain.id, settlement),
				types: TERMS_TYPES,
				primaryType: "Terms",
				message: t,
			}),
		).toBe(onChain);
	});

	it("the log root rebuilt from log() equals logRoot() after updates from several publishers, some in one block", async () => {
		const pubs = [await net.client(), await net.client(), await net.client()];
		for (const p of pubs) await p.initRepo("m");
		await net.chain.setAutomine(false);
		try {
			const writes = pubs.map((p, i) =>
				p.uploadBatch("m", [{ id: `x${String(i)}`, type: "t", payload: {} }]),
			);
			while ((await net.chain.getTxpoolStatus()).pending < pubs.length)
				await new Promise((r) => setTimeout(r, 50));
			await net.chain.mine({ blocks: 1 });
			await Promise.all(writes);
		} finally {
			await net.chain.setAutomine(true);
		}
		const log = await pubs[0].getRegistry().log({}, 0n);
		const root = await net.chain.readContract({
			address: net.config.dataRegistryContractAddress,
			abi: DATA_REGISTRY_ABI,
			functionName: "logRoot",
		});
		const length = await net.chain.readContract({
			address: net.config.dataRegistryContractAddress,
			abi: DATA_REGISTRY_ABI,
			functionName: "logLength",
		});
		expect(BigInt(log.length)).toBe(length);
		expect(mmrRoot(log.map(logLeaf).reduce(mmrAppend, EMPTY_MMR))).toBe(root);
	}, 60_000);

	describe("interleavings", () => {
		it.each([
			["two clients with the same key", true],
			["ONE client", false],
		])(
			"%s push to DIFFERENT repos while a block is pending",
			async (_, twoClients) => {
				const sk = generatePrivateKey();
				const a = await net.client(sk);
				const b = twoClients ? await net.client(sk) : a;
				await a.initRepo("p");
				await a.initRepo("q");
				await net.chain.setAutomine(false);
				let results: PromiseSettledResult<unknown>[];
				try {
					const settled = Promise.allSettled([
						a.uploadBatch("p", [{ id: "1", type: "t", payload: {} }]),
						b.uploadBatch("q", [{ id: "1", type: "t", payload: {} }]),
					]);
					// give both a chance to reach the pool, then mine whatever is there
					await new Promise((r) => setTimeout(r, 1500));
					await net.chain.mine({ blocks: 1 });
					results = await settled;
				} finally {
					await net.chain.setAutomine(true);
				}
				// "pushes to different repos never contend" (Fangorn.push)
				expect(
					results.map((r) =>
						r.status === "fulfilled"
							? "ok"
							: (/underpriced|nonce/i.exec((r.reason as Error).message)?.[0] ??
								(r.reason as Error).message.slice(0, 60)),
					),
				).toEqual(["ok", "ok"]);
			},
			60_000,
		);

		it("two clients with the same key push to the SAME repo: one lands, the other fails loudly", async () => {
			const sk = generatePrivateKey();
			const [a, b] = [await net.client(sk), await net.client(sk)];
			await a.initRepo("s");
			const results = await Promise.allSettled([
				a.uploadBatch("s", [{ id: "a", type: "t", payload: {} }]),
				b.uploadBatch("s", [{ id: "b", type: "t", payload: {} }]),
			]);
			const ok = results.filter((r) => r.status === "fulfilled").length;
			const head = await a
				.getRegistry()
				.headAt({ publisher: a.getAddress(), repo: "s" });
			// whatever reported success is on chain, and nothing else
			expect(head.pos).toBe(1 + ok);
			expect(ok).toBeGreaterThanOrEqual(1);
		}, 60_000);

		it("a subscriber started mid-history, with the head moved twice between polls", async () => {
			const pub = await net.client();
			await pub.initRepo("mid");
			await pub.upload("mid", { n: 0 }, "t", "old");
			const from = await net.clock();
			await pub.upload("mid", { n: 1 }, "t", "a");
			const reader = await net.client();
			const ctl = new AbortController();
			const stream = reader.subscribe({
				owner: pub.getAddress(),
				repo: "mid",
				fromBlock: from + 1n,
				signal: ctl.signal,
				pollingInterval: 3_000,
			});
			const got: RepoChange[] = [];
			const done = (async () => {
				for await (const c of stream) {
					got.push(c);
					if (got.length === 3) break;
				}
			})();
			await new Promise((r) => setTimeout(r, 200));
			await pub.upload("mid", { n: 2 }, "t", "b");
			await pub.upload("mid", { n: 3 }, "t", "c");
			await done;
			ctl.abort();
			expect(got.map((c) => c.puts.map((r) => r.id))).toEqual([
				["a"],
				["b"],
				["c"],
			]);
			expect(got[1].oldRoot).toBe(got[0].newRoot);
			expect(got[2].oldRoot).toBe(got[1].newRoot);
		}, 60_000);

		it("one update with no blocks behind it, from any address, does not end a subscribeAll", async () => {
			const pub = await net.client();
			await pub.initRepo("victim");
			const attacker = await net.client();
			const from = await net.clock();
			await pub.upload("victim", { n: 1 }, "t", "a");
			// straight to the registry: nothing uploaded to storage
			const car = CID.createV1(
				raw.code,
				await sha256.digest(new Uint8Array([7])),
			);
			await attacker.getRegistry().update({
				repo: "victim",
				epoch: await attacker.getRegistry().epoch(),
				parent: ZERO_HEAD,
				diff: junk(),
				root: junk(),
				car: bytesToHex(car.bytes),
			});
			await pub.upload("victim", { n: 2 }, "t", "b");
			const reader = await net.client();
			const ctl = new AbortController();
			const got: string[][] = [];
			let error: string | null = null;
			try {
				for await (const c of reader.subscribeAll({
					repo: "victim",
					fromBlock: from,
					signal: ctl.signal,
					pollingInterval: 100,
				})) {
					got.push(c.puts.map((r) => r.id));
					if (got.length === 2) break;
				}
			} catch (e) {
				error = (e as Error).message.slice(0, 80);
			}
			ctl.abort();
			expect({ got, error }).toEqual({ got: [["a"], ["b"]], error: null });
		}, 30_000);
	});

	describe("paid access across subjects and generations", () => {
		let server: Server;
		let keyServer: string;
		const ksSecret = x25519.utils.randomSecretKey();

		beforeAll(async () => {
			const ks = await net.client();
			const registry = ks.getSettlementRegistry();
			server = createServer((req, res) => {
				let body = "";
				req.on("data", (c: Buffer) => (body += c.toString()));
				req.on("end", () => {
					testKeyServer(JSON.parse(body) as AccessRequest, {
						secret: ksSecret,
						chainId: net.config.chain.id,
						registry: registry.getAddress(),
						canRead: (r, p, repo, key) => registry.canRead(r, p, repo, key),
					}).then(
						async (out) => res.writeHead(out.status).end(await out.text()),
						(e: unknown) => res.writeHead(500).end(String(e)),
					);
				});
			});
			await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
			keyServer = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
		}, 60_000);
		afterAll(() => server.close());

		async function depositFor(pub: Fangorn, name: string) {
			const s = pub.getSettlementRegistry();
			const scope: PaidScope = {
				chainId: net.config.chain.id,
				registry: s.getAddress(),
				publisher: pub.getAddress(),
				repo: repoId(name),
				generation: await s.generationOf(pub.getAddress(), repoId(name)),
			};
			const kRepo = newRepoKey();
			return {
				scope,
				kRepo,
				deposit: makeDeposit({
					kRepo,
					keyServerPubkey: x25519.getPublicKey(ksSecret),
					keyServer,
					scope,
				}),
			};
		}

		/** Pay (mock USDC, mock Semaphore) for `key` of `name` at `price`, settled to `reader`. */
		async function buy(
			pub: Fangorn,
			name: string,
			key: Hex,
			price: bigint,
			reader: Address,
		) {
			const terms = await pub.getSettlementRegistry().signTerms({
				repo: repoId(name),
				key,
				price,
				shareBps: 0,
				deadline: 2_000_000_000n,
			});
			const buyer = await net.client();
			const s = buyer.getSettlementRegistry();
			const subject = subjectOf(pub.getAddress(), repoId(name), key);
			const commitment = BigInt(generatePrivateKey());
			const salt = generatePrivateKey();
			const zero = "0x0000000000000000000000000000000000000000" as Address;
			await s.register({
				...terms,
				commitment,
				referrer: zero,
				salt,
				payment: {
					from: buyer.getAddress(),
					value: price,
					validAfter: 0n,
					validBefore: 2_000_000_000n,
					nonce: registerNonce(subject, commitment, zero, salt),
					v: 27,
					r: ZERO_HEAD,
					s: ZERO_HEAD,
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

		it("a cheap record's buyer gets neither a dearer record's key nor the repo key", async () => {
			const pub = await net.client();
			await pub.initRepo("shop");
			const { deposit } = await depositFor(pub, "shop");
			const reader = privateKeyToAccount(generatePrivateKey());
			await buy(pub, "shop", recordKey("cheap"), 1n, reader.address);
			await expect(
				requestKey({ deposit, key: recordKey("cheap"), signer: reader }),
			).resolves.toBeInstanceOf(Uint8Array);
			await expect(
				requestKey({ deposit, key: recordKey("dear"), signer: reader }),
			).rejects.toThrow(/403/);
			await expect(
				requestKey({ deposit, key: WHOLE_REPO, signer: reader }),
			).rejects.toThrow(/403/);
		}, 60_000);

		it("a purchase in one repo doesn't open a deposit of the publisher's other repo", async () => {
			const pub = await net.client();
			const { deposit: dearDeposit } = await depositFor(pub, "dear");
			const reader = privateKeyToAccount(generatePrivateKey());
			await buy(pub, "cheap", WHOLE_REPO, 1n, reader.address);
			// the request names the cheap repo, the sealed blob is the dear repo's
			await expect(
				requestKey({
					deposit: { ...dearDeposit, repo: repoId("cheap") },
					key: WHOLE_REPO,
					signer: reader,
				}),
			).rejects.toThrow(/400/);
		}, 60_000);

		it("after raiseGeneration, does a buyer of the old generation still get the NEW generation's keys?", async () => {
			const pub = await net.client();
			await pub.initRepo("gen");
			const reader = privateKeyToAccount(generatePrivateKey());
			await buy(pub, "gen", WHOLE_REPO, 1n, reader.address);
			await pub.getSettlementRegistry().raiseGeneration(repoId("gen"));
			const next = await depositFor(pub, "gen");
			expect(next.scope.generation).toBe(1n);
			// design question: access is per subject, not per generation
			const k = await requestKey({
				deposit: next.deposit,
				key: WHOLE_REPO,
				signer: reader,
			});
			expect(bytesToHex(k)).toBe(bytesToHex(next.kRepo));
			const stmt = statement(next.scope);
			expect(deriveRecordKey(k, stmt, recordKey("new"))).toEqual(
				deriveRecordKey(next.kRepo, stmt, recordKey("new")),
			);
		}, 60_000);

		it("disabling the whole repo stops a record buyer's key", async () => {
			const pub = await net.client();
			await pub.initRepo("off");
			const { deposit } = await depositFor(pub, "off");
			const reader = privateKeyToAccount(generatePrivateKey());
			await buy(pub, "off", recordKey("a"), 1n, reader.address);
			await pub
				.getSettlementRegistry()
				.setDisabled(repoId("off"), WHOLE_REPO, true);
			await expect(
				requestKey({ deposit, key: recordKey("a"), signer: reader }),
			).rejects.toThrow(/403/);
		}, 60_000);
	});
});
