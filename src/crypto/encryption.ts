import { x25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { bytesToHex, hexToBytes, type Hex } from "viem";
import { HandleFieldInput } from "../roles/publisher/types";
import { aesGcmEncrypt, aesGcmDecrypt, GCM_NONCE_LENGTH } from "./aes.js";
import { getRandomValues } from "./rand.js";

// Encrypts a payload so that only the TEE holding `teeSecret` can open it, and
// only when bound to a specific `resourceId`.
//
// Encryption requires a key exchange (with the TEE pubkey) first.
//
//   ephemeral-static X25519 ECDH => HKDF-SHA256 => AES-256-GCM
//   ciphertext layout: ephemeralPub(32) || nonce(12) || aes-256-gcm(ct || tag)
//
// The AES-GCM primitives live in ./aes.ts
// This contains only key exchange and resource binding.

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

// used for ciphertext hashes
export const sha256Hex = (bytes: Uint8Array): Hex => bytesToHex(sha256(bytes));

// HKDF `info` that binds a key to a specific resource: resourceId(32) || ":sealed"
const sealInfo = (resourceId: Hex): Uint8Array =>
	concat(hexToBytes(resourceId), utf8(":sealed"));

/**
 * Ephemeral-static ECDH to the TEE's static key, keyed to the resourceId.
 *
 *   ciphertext = ephemeralPub(32) || nonce(12) || aes-256-gcm-ct
 *
 * Only the holder of the secret matching `teePubkey` can derive the same AES
 * key, and only with the matching `resourceId`.
 */
export function seal(
	plaintext: Uint8Array,
	teePubkey: Uint8Array,
	resourceId: Hex,
): Uint8Array {
	const ephSec = x25519.utils.randomSecretKey();
	const ephPub = x25519.getPublicKey(ephSec);
	const shared = x25519.getSharedSecret(ephSec, teePubkey);
	const aesKey = hkdfSha256(shared, undefined, sealInfo(resourceId), 32);
	const nonce = getRandomValues(new Uint8Array(GCM_NONCE_LENGTH));
	const aesCt = aesGcmEncrypt(aesKey, plaintext, nonce);
	return concat(ephPub, nonce, aesCt);
}

/**
 * Inverse of {@link seal}. Recovers the plaintext given the TEE's static secret
 * and the same resourceId. This is the operation the real TEE performs after the
 * settlement gate passes; exposed here for parity testing and local tooling.
 */
export function unseal(
	ciphertext: Uint8Array,
	teeSecret: Uint8Array,
	resourceId: Hex,
): Uint8Array {
	const ephPub = ciphertext.slice(0, X25519_PUBKEY_LENGTH);
	const nonce = ciphertext.slice(
		X25519_PUBKEY_LENGTH,
		X25519_PUBKEY_LENGTH + GCM_NONCE_LENGTH,
	);
	const aesCt = ciphertext.slice(X25519_PUBKEY_LENGTH + GCM_NONCE_LENGTH);
	const shared = x25519.getSharedSecret(teeSecret, ephPub);
	const aesKey = hkdfSha256(shared, undefined, sealInfo(resourceId), 32);
	return aesGcmDecrypt(aesKey, aesCt, nonce);
}

export interface EncryptAndUploadParams {
	plaintext: Uint8Array;
	/** 32-byte resource identifier the ciphertext is bound to (HKDF info + settlement key). */
	resourceId: Hex;
	storage: {
		// R2 worker upload endpoint
		workerUrl: string;
		// JWT for the worker
		authToken: string;
		contentType: string;
	};
	/** TEE's static X25519 public key (32 bytes). */
	teePubkey: Uint8Array;
	// defaults to "tee-aes-v1"
	gadget?: string;
}

/**
 * Seal `plaintext` to the TEE, upload the opaque ciphertext to the storage
 * worker, and return the manifest handle describing where to fetch it and how
 * to verify/decrypt it.
 */
export async function encryptAndUpload(
	params: EncryptAndUploadParams,
): Promise<HandleFieldInput> {
	const {
		plaintext,
		resourceId,
		storage,
		teePubkey,
		gadget = "tee-aes-v1",
	} = params;

	const ciphertext = seal(plaintext, teePubkey, resourceId);

	// upload ciphertext to worker (which writes opaque bytes to R2)
	const uploadRes = await fetch(`${storage.workerUrl}/upload`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${storage.authToken}`,
			"Content-Type": storage.contentType,
		},
		body: ciphertext as unknown as BodyInit,
	});
	if (!uploadRes.ok) throw new Error(`upload failed: ${uploadRes.status}`);
	const { objectKey } = await uploadRes.json();

	return {
		"@type": "handle",
		uri: objectKey,
		workerUrl: storage.workerUrl,
		encryption: {
			gadget,
			ciphertextHash: sha256Hex(ciphertext),
			teePubkey: bytesToHex(teePubkey),
		},
	};
}
