import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import { x25519 } from "@noble/curves/ed25519";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { aesGcmDecrypt, aesGcmEncrypt } from "./aes.js";
import { seal, sealSelf, unseal, unsealSelf } from "./encryption.js";
import {
	accessMessage,
	decryptField,
	deriveRecordKey,
	encryptField,
	makeDeposit,
	newRepoKey,
	requestKey,
	statement,
	type PaidScope,
} from "./paid.js";

// Property tests for the sealing primitives. Fixed seeds; FUZZ_RUNS overrides the run count.
const RUNS = Number(process.env.FUZZ_RUNS ?? 150);
// ~4ms a run for the slowest property (x25519): room for FUZZ_RUNS in the thousands.
vi.setConfig({ testTimeout: Math.max(5_000, RUNS * 10) });
const opts = (seed: number) => ({ seed, numRuns: RUNS });

const bytes32 = fc.uint8Array({ minLength: 32, maxLength: 32 });
const hex32 = bytes32.map((b) => bytesToHex(b));
const address = fc
	.uint8Array({ minLength: 20, maxLength: 20 })
	.map((b): Address => bytesToHex(b));
const plaintext = fc.oneof(
	fc.uint8Array({ maxLength: 512 }),
	fc
		.string({ unit: "grapheme", maxLength: 64 })
		.map((s) => new TextEncoder().encode(s)),
);
const fieldName = fc.string({ unit: "grapheme", maxLength: 24 });
const scopeArb: fc.Arbitrary<PaidScope> = fc.record({
	chainId: fc.integer({ min: 1, max: 2 ** 31 }),
	registry: address,
	publisher: address,
	repo: hex32,
	generation: fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }),
});

/** Flip bit `bit` of byte `i % len`. */
const flip = (b: Uint8Array, i: number, bit: number) => {
	const out = b.slice();
	out[i % out.length] ^= 1 << bit;
	return out;
};

// Independent ABI encoding (no viem encoder) for the differential checks.
const word = (h: string) =>
	h.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const uint = (n: bigint | number) => word(BigInt(n).toString(16));
const keccakHex = (h: string) => bytesToHex(keccak_256(hexToBytes(`0x${h}`)));
/** abi.encode(string tag, ...static words): tag goes in the tail. */
const encodeTagged = (tag: string, words: string[]) => {
	const t = new TextEncoder().encode(tag);
	const data = bytesToHex(t)
		.slice(2)
		.padEnd(Math.ceil(t.length / 32) * 64, "0");
	return uint(32 * (words.length + 1)) + words.join("") + uint(t.length) + data;
};

describe("aes-256-gcm", () => {
	it("round-trips any bytes and aad", () => {
		fc.assert(
			fc.property(
				bytes32,
				plaintext,
				fc.uint8Array({ maxLength: 64 }),
				(k, pt, aad) => {
					const n = crypto.getRandomValues(new Uint8Array(12));
					expect(
						aesGcmDecrypt(k, aesGcmEncrypt(k, pt, n, aad), n, aad),
					).toEqual(pt);
				},
			),
			opts(1),
		);
	});
});

describe("paid fields", () => {
	it("round-trip: any plaintext, statement, key and field name", () => {
		fc.assert(
			fc.property(
				bytes32,
				scopeArb,
				hex32,
				fieldName,
				plaintext,
				(kRepo, s, key, field, pt) => {
					const stmt = statement(s);
					const kRec = deriveRecordKey(kRepo, stmt, key);
					const ct = encryptField(kRec, pt, stmt, key, field);
					expect(ct.length).toBe(12 + pt.length + 16);
					expect(decryptField(kRec, ct, stmt, key, field)).toEqual(pt);
				},
			),
			opts(2),
		);
	});

	it("any single bit flip in nonce, ciphertext or tag is rejected", () => {
		fc.assert(
			fc.property(
				bytes32,
				hex32,
				hex32,
				fieldName,
				plaintext,
				fc.nat(),
				fc.integer({ min: 0, max: 7 }),
				(kRec, stmt, key, field, pt, i, bit) => {
					const ct = encryptField(kRec, pt, stmt, key, field);
					expect(() =>
						decryptField(kRec, flip(ct, i, bit), stmt, key, field),
					).toThrow();
				},
			),
			opts(3),
		);
	});

	it("any truncation is rejected", () => {
		fc.assert(
			fc.property(
				bytes32,
				hex32,
				hex32,
				plaintext,
				fc.nat(),
				(kRec, stmt, key, pt, cut) => {
					const ct = encryptField(kRec, pt, stmt, key, "f");
					const short = ct.slice(0, cut % ct.length);
					expect(() => decryptField(kRec, short, stmt, key, "f")).toThrow();
				},
			),
			opts(4),
		);
	});

	it("a field sealed in one context doesn't open in another (statement, record, field name)", () => {
		const ctx = fc.tuple(hex32, hex32, fieldName);
		fc.assert(
			fc.property(
				bytes32,
				ctx,
				ctx,
				plaintext,
				(kRepo, [stmtA, keyA, fA], [stmtB, keyB, fB], pt) => {
					fc.pre(stmtA !== stmtB || keyA !== keyB || fA !== fB);
					const ct = encryptField(
						deriveRecordKey(kRepo, stmtA, keyA),
						pt,
						stmtA,
						keyA,
						fA,
					);
					// Even with A's record key in hand (a buyer of A), B's context rejects it.
					const kA = deriveRecordKey(kRepo, stmtA, keyA);
					expect(() => decryptField(kA, ct, stmtB, keyB, fB)).toThrow();
					// And B's record key equals A's only when they're the same record.
					expect(
						bytesToHex(deriveRecordKey(kRepo, stmtB, keyB)) === bytesToHex(kA),
					).toBe(stmtA === stmtB && keyA === keyB);
				},
			),
			opts(5),
		);
	});

	it("statement and accessMessage match an independent abi.encode", () => {
		fc.assert(
			fc.property(scopeArb, hex32, hex32, fc.nat(), (s, key, rk, ts) => {
				expect(statement(s)).toBe(
					keccakHex(
						encodeTagged("fangorn:pay:v1", [
							uint(s.chainId),
							word(s.registry),
							word(s.publisher),
							word(s.repo),
							uint(s.generation),
						]),
					),
				);
				const stmt = statement(s);
				expect(accessMessage(stmt, key, rk, ts)).toBe(
					keccakHex(
						encodeTagged("fangorn:access:v1", [
							word(stmt),
							word(key),
							word(rk),
							uint(ts),
						]),
					),
				);
			}),
			opts(6),
		);
	});

	it("any scope field change changes the statement", () => {
		fc.assert(
			fc.property(scopeArb, scopeArb, (a, b) => {
				fc.pre(
					JSON.stringify({ ...a, generation: String(a.generation) }) !==
						JSON.stringify({ ...b, generation: String(b.generation) }),
				);
				expect(statement(a)).not.toBe(statement(b));
			}),
			opts(7),
		);
	});
});

describe("seal / sealSelf", () => {
	const sk = x25519.utils.randomSecretKey();
	const pk = x25519.getPublicKey(sk);

	it("seal round-trips and rejects any bit flip or other resource id", () => {
		fc.assert(
			fc.property(
				plaintext,
				hex32,
				hex32,
				fc.nat(),
				fc.integer({ min: 0, max: 7 }),
				(pt, id, other, i, bit) => {
					const ct = seal(pt, pk, id);
					expect(unseal(ct, sk, id)).toEqual(pt);
					// a flipped ephemeral key bit may be a non-canonical u (rejected) or a different key
					expect(() => unseal(flip(ct, i, bit), sk, id)).toThrow();
					fc.pre(other !== id);
					expect(() => unseal(ct, sk, other)).toThrow();
				},
			),
			opts(8),
		);
	});

	it("rejects a non-canonical ephemeral key (top bit set, or u >= p)", () => {
		const id: Hex = `0x${"11".repeat(32)}`;
		const ct = seal(new Uint8Array([1, 2, 3]), pk, id);
		expect(() => unseal(flip(ct, 31, 7), sk, id)).toThrow(/non-canonical/);
		// u = p + 1 is the same point as u = 1 (low order); it must not reach x25519 at all
		const pPlus1 = new Uint8Array(32).fill(0xff);
		pPlus1[0] = 0xee;
		pPlus1[31] = 0x7f;
		const forged = ct.slice();
		forged.set(pPlus1, 0);
		expect(() => unseal(forged, sk, id)).toThrow(/non-canonical/);
	});

	it("sealSelf round-trips and rejects any bit flip or other resource id", () => {
		fc.assert(
			fc.property(
				bytes32,
				plaintext,
				hex32,
				hex32,
				fc.nat(),
				fc.integer({ min: 0, max: 7 }),
				(own, pt, id, other, i, bit) => {
					const ct = sealSelf(pt, own, id);
					expect(unsealSelf(ct, own, id)).toEqual(pt);
					expect(() => unsealSelf(flip(ct, i, bit), own, id)).toThrow();
					fc.pre(other !== id);
					expect(() => unsealSelf(ct, own, other)).toThrow();
				},
			),
			opts(9),
		);
	});
});

describe("requestKey trusts the key server's reply", () => {
	// The reply is sealed to the request's readerKey, which travels in clear. ECIES with an
	// ephemeral sender key authenticates nobody, so whoever answers /access (a MITM on a
	// plain-http keyServer, or a buggy key server) can hand back any key. A buyer catches
	// that when the field fails its tag; the publisher's `requestKey(WHOLE_REPO)` in
	// sealRecords cannot, and seals new records under the substituted key.
	it.fails("rejects a repo key that isn't the one in the deposit", async () => {
		const ksSecret = x25519.utils.randomSecretKey();
		const pub = privateKeyToAccount(generatePrivateKey());
		const scope: PaidScope = {
			chainId: 1,
			registry: "0x00000000000000000000000000000000000000aa",
			publisher: pub.address,
			repo: `0x${"cd".repeat(32)}`,
			generation: 0n,
		};
		const deposit = makeDeposit({
			kRepo: newRepoKey(),
			keyServerPubkey: x25519.getPublicKey(ksSecret),
			keyServer: "http://keys.test",
			scope,
		});
		const attackerKey = new Uint8Array(32).fill(7);
		const fetch = ((_u: string, init: RequestInit) => {
			const { readerKey } = JSON.parse(init.body as string) as {
				readerKey: Hex;
			};
			const sealed = bytesToHex(
				seal(attackerKey, hexToBytes(readerKey), statement(scope)),
			);
			return Promise.resolve(Response.json({ sealed }));
		}) as unknown as typeof globalThis.fetch;
		await expect(
			requestKey({ deposit, key: `0x${"00".repeat(32)}`, signer: pub, fetch }),
		).rejects.toThrow();
	});
});
