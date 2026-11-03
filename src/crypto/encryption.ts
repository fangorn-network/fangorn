import { x25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hexToBytes, type Hex } from "viem";
import { aesGcmEncrypt, aesGcmDecrypt, GCM_NONCE_LENGTH } from "./aes.js";
import { getRandomValues } from "./rand.js";

// Sealing primitives.
//
//   seal / unseal         X25519 to a recipient's static key, bound to a 32-byte id.
//                         Layout: ephemeralPub(32) || nonce(12) || aes-256-gcm(ct||tag)
//   sealSelf / unsealSelf a key derived from the owner's own secret, bound to an id.
//                         Layout: nonce(12) || aes-256-gcm(ct||tag)
//
// Paid fields (./paid.ts) are built on seal.

/** A field only its owner can open: sealSelf under the owner's own secret. */
export const GADGET_SELF_HKDF_V1 = "self-hkdf-v1";

/** Length of an X25519 public key, in bytes. */
export const X25519_PUBKEY_LENGTH = 32;

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

function concat(...parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.length;
	}
	return out;
}

const hkdfSha256 = (
	ikm: Uint8Array,
	salt: Uint8Array | undefined,
	info: Uint8Array,
	length: number,
): Uint8Array => hkdf(sha256, ikm, salt, info, length);

// HKDF `info` that binds a key to a specific resource: resourceId(32) || ":sealed"
const sealInfo = (resourceId: Hex): Uint8Array =>
	concat(hexToBytes(resourceId), utf8(":sealed"));

/**
 * Ephemeral-static ECDH to the recipient's static key, keyed to the resourceId.
 *
 *   ciphertext = ephemeralPub(32) || nonce(12) || aes-256-gcm-ct
 *
 * Only the holder of the secret matching `recipientPubkey` can derive the same AES
 * key, and only with the matching `resourceId`.
 */
export function seal(
	plaintext: Uint8Array,
	recipientPubkey: Uint8Array,
	resourceId: Hex,
): Uint8Array {
	const ephSec = x25519.utils.randomSecretKey();
	const ephPub = x25519.getPublicKey(ephSec);
	const shared = x25519.getSharedSecret(ephSec, recipientPubkey);
	const aesKey = hkdfSha256(shared, undefined, sealInfo(resourceId), 32);
	const nonce = getRandomValues(new Uint8Array(GCM_NONCE_LENGTH));
	const aesCt = aesGcmEncrypt(aesKey, plaintext, nonce);
	return concat(ephPub, nonce, aesCt);
}

/** Inverse of {@link seal}, with the recipient's secret and the same resourceId. */
export function unseal(
	ciphertext: Uint8Array,
	recipientSecret: Uint8Array,
	resourceId: Hex,
): Uint8Array {
	const ephPub = ciphertext.slice(0, X25519_PUBKEY_LENGTH);
	const nonce = ciphertext.slice(
		X25519_PUBKEY_LENGTH,
		X25519_PUBKEY_LENGTH + GCM_NONCE_LENGTH,
	);
	const aesCt = ciphertext.slice(X25519_PUBKEY_LENGTH + GCM_NONCE_LENGTH);
	const shared = x25519.getSharedSecret(recipientSecret, ephPub);
	const aesKey = hkdfSha256(shared, undefined, sealInfo(resourceId), 32);
	return aesGcmDecrypt(aesKey, aesCt, nonce);
}

/**
 * Derive the AES key straight from the owner's own 32-byte
 * secret, bound to the resourceId. No ECDH, no recipient — only a party holding
 * `ownSecret` can re-derive the key.
 *
 *   ciphertext = nonce(12) || aes-256-gcm-ct
 */
export function sealSelf(
	plaintext: Uint8Array,
	ownSecret: Uint8Array,
	resourceId: Hex,
): Uint8Array {
	const aesKey = hkdfSha256(ownSecret, undefined, sealInfo(resourceId), 32);
	const nonce = getRandomValues(new Uint8Array(GCM_NONCE_LENGTH));
	const aesCt = aesGcmEncrypt(aesKey, plaintext, nonce);
	return concat(nonce, aesCt);
}

/** Inverse of {@link sealSelf}. */
export function unsealSelf(
	ciphertext: Uint8Array,
	ownSecret: Uint8Array,
	resourceId: Hex,
): Uint8Array {
	const nonce = ciphertext.slice(0, GCM_NONCE_LENGTH);
	const aesCt = ciphertext.slice(GCM_NONCE_LENGTH);
	const aesKey = hkdfSha256(ownSecret, undefined, sealInfo(resourceId), 32);
	return aesGcmDecrypt(aesKey, aesCt, nonce);
}

/** Anything that can personal_sign a raw 32-byte hash (viem LocalAccount / WalletClient). */
export interface AccessSigner {
	signMessage(args: { message: { raw: Hex } }): Promise<Hex>;
}
