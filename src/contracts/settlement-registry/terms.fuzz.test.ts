import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
	bytesToHex,
	hashTypedData,
	hexToBytes,
	recoverTypedDataAddress,
	type Address,
	type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
	TERMS_TYPES,
	recordKey,
	registerNonce,
	settlementDomain,
	subjectOf,
	termsFromJson,
	termsToJson,
	type Terms,
	type TermsJson,
} from "./index.js";

// Differential tests: the SDK's ids and EIP-712 digest against an encoder written from
// SettlementRegistry.sol by hand (no viem ABI encoder, no viem typed-data code).
const RUNS = Number(process.env.FUZZ_RUNS ?? 150);
// ~4ms a run for the slowest property (x25519): room for FUZZ_RUNS in the thousands.
vi.setConfig({ testTimeout: Math.max(5_000, RUNS * 10) });
const opts = (seed: number) => ({ seed, numRuns: RUNS });

const hex32 = fc
	.uint8Array({ minLength: 32, maxLength: 32 })
	.map((b) => bytesToHex(b));
const address = fc
	.uint8Array({ minLength: 20, maxLength: 20 })
	.map((b): Address => bytesToHex(b));
const uintN = (bits: number) =>
	fc.bigInt({ min: 0n, max: 2n ** BigInt(bits) - 1n });
const termsArb: fc.Arbitrary<Terms> = fc.record({
	publisher: address,
	repo: hex32,
	key: hex32,
	price: uintN(256),
	shareBps: fc.integer({ min: 0, max: 10_000 }),
	generation: uintN(64),
	deadline: uintN(64),
});

const word = (h: string) =>
	h.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const uint = (n: bigint | number) => word(BigInt(n).toString(16));
const k = (h: string) => bytesToHex(keccak_256(hexToBytes(`0x${h}`))).slice(2);
const kStr = (s: string) =>
	bytesToHex(keccak_256(new TextEncoder().encode(s))).slice(2);

// Verbatim from SettlementRegistry.sol and OpenZeppelin EIP712Upgradeable.
const TERMS_TYPE =
	"Terms(address publisher,bytes32 repo,bytes32 key,uint256 price,uint16 shareBps,uint64 generation,uint64 deadline)";
const DOMAIN_TYPE =
	"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";

/** _hashTypedDataV4(keccak256(abi.encode(TERMS_TYPEHASH, ...))) */
function hashTermsSol(t: Terms, chainId: number, registry: Address): Hex {
	const domainSeparator = k(
		kStr(DOMAIN_TYPE) +
			kStr("Fangorn Settlement") +
			kStr("1") +
			uint(chainId) +
			word(registry),
	);
	const structHash = k(
		kStr(TERMS_TYPE) +
			word(t.publisher) +
			word(t.repo) +
			word(t.key) +
			uint(t.price) +
			uint(t.shareBps) +
			uint(t.generation) +
			uint(t.deadline),
	);
	return `0x${k("1901" + domainSeparator + structHash)}`;
}

describe("EIP-712 terms", () => {
	it("the SDK's domain and types hash exactly as the contract's hashTerms", () => {
		fc.assert(
			fc.property(
				termsArb,
				fc.integer({ min: 1, max: 2 ** 40 }),
				address,
				(t, chainId, reg) => {
					expect(
						hashTypedData({
							domain: settlementDomain(chainId, reg),
							types: TERMS_TYPES,
							primaryType: "Terms",
							message: t,
						}),
					).toBe(hashTermsSol(t, chainId, reg));
				},
			),
			opts(11),
		);
	});

	it("a signature recovers only under the same chain and registry", async () => {
		const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
		await fc.assert(
			fc.asyncProperty(termsArb, address, address, async (t, reg, other) => {
				fc.pre(reg !== other);
				const signature = await account.sign({ hash: hashTermsSol(t, 1, reg) });
				const recover = (chainId: number, r: Address) =>
					recoverTypedDataAddress({
						domain: settlementDomain(chainId, r),
						types: TERMS_TYPES,
						primaryType: "Terms",
						message: t,
						signature,
					});
				expect(await recover(1, reg)).toBe(account.address);
				expect(await recover(2, reg)).not.toBe(account.address);
				expect(await recover(1, other)).not.toBe(account.address);
			}),
			{ ...opts(12), numRuns: Math.max(1, Math.floor(RUNS / 5)) },
		);
	});

	it("out-of-range fields don't sign: viem refuses them rather than truncating", () => {
		fc.assert(
			fc.property(
				termsArb,
				fc.constantFrom("shareBps", "generation", "deadline"),
				(t, field) => {
					const bad = {
						...t,
						[field]: field === "shareBps" ? 65_536 : 2n ** 64n,
					} as Terms;
					expect(() =>
						hashTypedData({
							domain: settlementDomain(1, t.publisher),
							types: TERMS_TYPES,
							primaryType: "Terms",
							message: bad,
						}),
					).toThrow();
				},
			),
			opts(13),
		);
	});

	it("JSON round-trips exactly", () => {
		fc.assert(
			fc.property(termsArb, hex32, (terms, signature) => {
				const json = JSON.parse(
					JSON.stringify(termsToJson({ terms, signature })),
				) as TermsJson;
				expect(termsFromJson(json)).toEqual({ terms, signature });
			}),
			opts(14),
		);
	});
});

describe("ids", () => {
	it("subjectOf and registerNonce match abi.encode from the contract", () => {
		fc.assert(
			fc.property(
				address,
				hex32,
				hex32,
				uintN(256),
				address,
				hex32,
				(p, repo, key, c, ref, salt) => {
					const subject = subjectOf(p, repo, key);
					expect(subject).toBe(`0x${k(word(p) + word(repo) + word(key))}`);
					expect(registerNonce(subject, c, ref, salt)).toBe(
						`0x${k(word(subject) + uint(c) + word(ref) + word(salt))}`,
					);
				},
			),
			opts(15),
		);
	});

	it("recordKey is keccak256 of the id's UTF-8 bytes, and distinct ids give distinct keys", () => {
		const id = fc.string({ unit: "grapheme", maxLength: 40 });
		fc.assert(
			fc.property(id, id, (a, b) => {
				expect(recordKey(a)).toBe(`0x${kStr(a)}`);
				expect(recordKey(a) === recordKey(b)).toBe(a === b);
				expect(BigInt(recordKey(a))).not.toBe(0n); // never WHOLE_REPO
			}),
			opts(16),
		);
	});
});
