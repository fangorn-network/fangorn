import { describe, it, expect } from "vitest";
import { x25519 } from "@noble/curves/ed25519";
import {
	encodePacked,
	keccak256,
	recoverMessageAddress,
	type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
	seal,
	unseal,
	sealSelf,
	unsealSelf,
	accessMessageHash,
	buildAccessRequest,
	X25519_PUBKEY_LENGTH,
} from "./encryption.js";
import { GCM_NONCE_LENGTH } from "./aes.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

const randomBytes = (n: number) => {
	const a = new Uint8Array(n);
	for (let i = 0; i < n; i++) a[i] = Math.floor(Math.random() * 256);
	return a;
};

// two distinct 32-byte resource ids
const RES_A =
	"0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;
const RES_B =
	"0x2222222222222222222222222222222222222222222222222222222222222222" as Hex;

describe("self-hkdf-v1 gadget", () => {
	it("round-trips with the owner's own secret", () => {
		const ownSecret = randomBytes(32);
		const pt = enc.encode("fully private field");

		const ct = sealSelf(pt, ownSecret, RES_A);
		expect(dec.decode(unsealSelf(ct, ownSecret, RES_A))).toBe(
			"fully private field",
		);
	});

	it("emits only nonce(12) + tag(16) of overhead (no ephemeral pubkey)", () => {
		const pt = randomBytes(64);
		const ct = sealSelf(pt, randomBytes(32), RES_A);
		expect(ct.length).toBe(pt.length + GCM_NONCE_LENGTH + 16);
	});

	it("fails to open with a different secret", () => {
		const ct = sealSelf(enc.encode("secret"), randomBytes(32), RES_A);
		expect(() => unsealSelf(ct, randomBytes(32), RES_A)).toThrow();
	});

	it("is bound to the resourceId (wrong id cannot open)", () => {
		const ownSecret = randomBytes(32);
		const ct = sealSelf(enc.encode("secret"), ownSecret, RES_A);
		expect(() => unsealSelf(ct, ownSecret, RES_B)).toThrow();
	});
});

describe("worker-usdc-v1 gadget", () => {
	it("round-trips: sealed to the worker pubkey, opened by the worker secret", () => {
		const workerSecret = x25519.utils.randomSecretKey();
		const workerPubkey = x25519.getPublicKey(workerSecret);
		const pt = enc.encode("settlement-gated field");

		const ct = seal(pt, workerPubkey, RES_A);
		expect(dec.decode(unseal(ct, workerSecret, RES_A))).toBe(
			"settlement-gated field",
		);
	});

	it("carries an ephemeral pubkey in the header", () => {
		const workerPubkey = x25519.getPublicKey(x25519.utils.randomSecretKey());
		const pt = randomBytes(64);
		const ct = seal(pt, workerPubkey, RES_A);
		expect(ct.length).toBe(
			pt.length + X25519_PUBKEY_LENGTH + GCM_NONCE_LENGTH + 16,
		);
	});

	it("is bound to the resourceId (wrong id cannot open)", () => {
		const workerSecret = x25519.utils.randomSecretKey();
		const workerPubkey = x25519.getPublicKey(workerSecret);
		const ct = seal(enc.encode("secret"), workerPubkey, RES_A);
		expect(() => unseal(ct, workerSecret, RES_B)).toThrow();
	});

	it("cannot be opened by the wrong worker secret", () => {
		const workerPubkey = x25519.getPublicKey(x25519.utils.randomSecretKey());
		const ct = seal(enc.encode("secret"), workerPubkey, RES_A);
		expect(() =>
			unseal(ct, x25519.utils.randomSecretKey(), RES_A),
		).toThrow();
	});
});

describe("access request (/access rail)", () => {
	const objectKey = "tracks/user-1/track-abc.mp3";
	const nullifier =
		"0x000000000000000000000000000000000000000000000000000000000000002a" as Hex;

	it("hashes the packed message exactly as the worker does", () => {
		const ts = 1_700_000_000;
		// The worker's buildMessageHash, recomputed independently.
		const expected = keccak256(
			encodePacked(
				["uint256", "bytes32", "string", "uint64"],
				[BigInt(nullifier), RES_A, objectKey, BigInt(ts)],
			),
		);
		expect(accessMessageHash(nullifier, RES_A, objectKey, ts)).toBe(expected);
	});

	it("produces a signature the worker recovers to the signer's address", async () => {
		const account = privateKeyToAccount(
			"0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
		);
		const req = await buildAccessRequest({
			signer: account,
			nullifier,
			resourceId: RES_A,
			objectKey,
			timestamp: 1_700_000_000,
		});
		// Mirror the worker's recovery: recoverMessageAddress over the raw hash.
		const recovered = await recoverMessageAddress({
			message: {
				raw: accessMessageHash(
					req.nullifier,
					req.resourceId,
					req.objectKey,
					req.timestamp,
				),
			},
			signature: req.signature,
		});
		expect(recovered).toBe(account.address);
	});

	it("defaults the timestamp to now", async () => {
		const account = privateKeyToAccount(
			"0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
		);
		const before = Math.floor(Date.now() / 1000);
		const req = await buildAccessRequest({
			signer: account,
			nullifier,
			resourceId: RES_A,
			objectKey,
		});
		expect(req.timestamp).toBeGreaterThanOrEqual(before);
		expect(req.timestamp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
	});
});
