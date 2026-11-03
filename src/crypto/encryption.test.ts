import { describe, it, expect } from "vitest";
import { x25519 } from "@noble/curves/ed25519";
import type { Hex } from "viem";
import {
	seal,
	unseal,
	sealSelf,
	unsealSelf,
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

describe("seal", () => {
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
		expect(() => unseal(ct, x25519.utils.randomSecretKey(), RES_A)).toThrow();
	});
});
