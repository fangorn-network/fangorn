import { gcm } from "@noble/ciphers/aes.js";

/** AES-256 key length, in bytes. */
export const AES_KEY_LENGTH = 32;
/** GCM nonce (IV) length, in bytes. The standard 96-bit nonce. */
export const GCM_NONCE_LENGTH = 12;
/** GCM authentication tag length, in bytes. */
export const GCM_TAG_LENGTH = 16;

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
