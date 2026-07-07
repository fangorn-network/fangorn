import { gcm } from "@noble/ciphers/aes.js";
import { getRandomValues } from "./rand.js";
import { AesEncryptedData } from "./types.js";

/** AES-256 key length, in bytes. */
export const AES_KEY_LENGTH = 32;
/** GCM nonce (IV) length, in bytes. The standard 96-bit nonce. */
export const GCM_NONCE_LENGTH = 12;
/** GCM authentication tag length, in bytes. */
export const GCM_TAG_LENGTH = 16;

// === pure AES-256-GCM primitives ===
// These are intentionally dependency-free w.r.t. key derivation: callers bring
// their own 32-byte key and 12-byte nonce. Higher layers (e.g. the sealed-TEE
// flow in encryption.ts) derive the key via X25519 + HKDF and call these.

/**
 * AES-256-GCM encrypt. Returns the ciphertext with the 16-byte auth tag
 * appended (noble's convention) — i.e. `ciphertext || tag`.
 */
export function aesGcmEncrypt(
	key: Uint8Array,
	plaintext: Uint8Array,
	nonce: Uint8Array,
): Uint8Array {
	return gcm(key, nonce).encrypt(plaintext);
}

/**
 * AES-256-GCM decrypt. `sealed` is `ciphertext || tag` as produced by
 * {@link aesGcmEncrypt}. Throws if the tag does not verify.
 */
export function aesGcmDecrypt(
	key: Uint8Array,
	sealed: Uint8Array,
	nonce: Uint8Array,
): Uint8Array {
	return gcm(key, nonce).decrypt(sealed);
}

// encrypt under a fresh random key
// Generates a random AES-256 key + nonce, returning the key material separately
// so the caller can transport/wrap it however they like. 
export async function encryptData(data: string | Uint8Array): Promise<{
	encryptedData: AesEncryptedData;
	keyMaterial: Uint8Array<ArrayBuffer>;
}> {
	const salt = getRandomValues(new Uint8Array(16));
	const iv = getRandomValues(new Uint8Array(GCM_NONCE_LENGTH));
	const keyMaterial = getRandomValues(new Uint8Array(AES_KEY_LENGTH));

	const encodedData =
		typeof data === "string" ? new TextEncoder().encode(data) : data;

	const sealed = aesGcmEncrypt(keyMaterial, encodedData, iv);
	const ciphertext = sealed.slice(0, sealed.length - GCM_TAG_LENGTH);
	const authTag = sealed.slice(sealed.length - GCM_TAG_LENGTH);

	return {
		encryptedData: {
			ciphertext: new Uint8Array(ciphertext),
			iv,
			authTag: new Uint8Array(authTag),
			salt,
		},
		keyMaterial,
	};
}

export async function decryptData(
	encryptedData: AesEncryptedData,
	keyMaterial: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array> {
	// Ensure these are proper Uint8Arrays (may have been serialized to JSON).
	const ciphertext = toUint8Array(encryptedData.ciphertext);
	const iv = toUint8Array(encryptedData.iv);
	const authTag = toUint8Array(encryptedData.authTag);

	const sealed = new Uint8Array(ciphertext.length + authTag.length);
	sealed.set(ciphertext, 0);
	sealed.set(authTag, ciphertext.length);

	return aesGcmDecrypt(keyMaterial, sealed, iv);
}

function toUint8Array(
	data: Uint8Array | Record<string, number> | number[],
): Uint8Array<ArrayBuffer> {
	if (data instanceof Uint8Array) {
		return data as Uint8Array<ArrayBuffer>;
	}
	if (Array.isArray(data)) {
		return new Uint8Array(data);
	}
	return new Uint8Array(Object.values(data));
}
