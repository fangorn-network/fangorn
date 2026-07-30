import { x25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import {
	bytesToHex,
	encodePacked,
	hexToBytes,
	keccak256,
	type Hex,
} from "viem";
import { aesGcmEncrypt, aesGcmDecrypt, GCM_NONCE_LENGTH } from "./aes.js";
import { getRandomValues } from "./rand.js";

// ─── Gadgets ──────────────────────────────────────────────────────────────
//
// A "gadget" names the sealing + access condition a field is locked under. v1
// ships exactly two, both backed by opaque bytes in R2 (never IPFS) so a large,
// frequently-fetched ciphertext doesn't burn public gateway egress:
//
//   self-hkdf-v1   fully private. The key is HKDF'd from the owner's own secret,
//                  bound to the resourceId. Nobody else can re-derive it; the
//                  access worker does NO gating on reads — it's dumb storage.
//
//   worker-usdc-v1 settlement-gated. The ciphertext is sealed *to the access
//                  worker's* static X25519 key. On read, the worker checks the
//                  Settlement Registry (isSettled/getPrice) for the resourceId,
//                  unseals with its own key, and streams back plaintext. The
//                  worker is the "somewhat trusted" party — it sees plaintext at
//                  release time anyway — no TEE / Lit for v1. Swapping in a TEE
//                  later is a new gadget behind this same handle shape.

export const GADGET_SELF_HKDF_V1 = "self-hkdf-v1";
export const GADGET_WORKER_USDC_V1 = "worker-usdc-v1";

export type Gadget =
	| typeof GADGET_SELF_HKDF_V1
	| typeof GADGET_WORKER_USDC_V1;

/**
 * A sealed-field handle: where the ciphertext lives and how to verify/open it.
 * This is what gets embedded in a vertex `payload[field]` in place of the
 * plaintext value — the engine treats it as an opaque object.
 */
export interface HandleFieldInput {
	"@type": "handle";
	/** R2 object key. Signed over in the /access request; resolve via {@link decryptHandle}. */
	objectKey: string;
	/**
	 * Access-worker endpoint. NOTE: this is the *access* worker, distinct from
	 * the Pinata-presign upload worker in the CLI config — do not conflate them.
	 */
	workerUrl: string;
	encryption: {
		gadget: Gadget;
		/**
		 * 32-byte resource id the ciphertext is bound to. Doubles as the HKDF
		 * binding and the Settlement Registry key (`isSettled`/`getPrice`).
		 */
		resourceId: Hex;
		ciphertextHash: Hex;
		/** Present only for worker-usdc-v1: the worker's static X25519 pubkey. */
		workerPubkey?: Hex;
	};
}

// ─── Key exchange / resource binding ────────────────────────────────────────
//
// The AES-GCM primitives live in ./aes.ts. This file only does key derivation
// (X25519 ECDH for the worker gadget, HKDF-from-own-secret for the self gadget)
// and resource binding.
//
//   worker-usdc-v1 layout: ephemeralPub(32) || nonce(12) || aes-256-gcm(ct||tag)
//   self-hkdf-v1   layout:                     nonce(12) || aes-256-gcm(ct||tag)

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
 * worker-usdc-v1 seal: ephemeral-static ECDH to the worker's static key, keyed
 * to the resourceId.
 *
 *   ciphertext = ephemeralPub(32) || nonce(12) || aes-256-gcm-ct
 *
 * Only the holder of the secret matching `workerPubkey` can derive the same AES
 * key, and only with the matching `resourceId`.
 */
export function seal(
	plaintext: Uint8Array,
	workerPubkey: Uint8Array,
	resourceId: Hex,
): Uint8Array {
	const ephSec = x25519.utils.randomSecretKey();
	const ephPub = x25519.getPublicKey(ephSec);
	const shared = x25519.getSharedSecret(ephSec, workerPubkey);
	const aesKey = hkdfSha256(shared, undefined, sealInfo(resourceId), 32);
	const nonce = getRandomValues(new Uint8Array(GCM_NONCE_LENGTH));
	const aesCt = aesGcmEncrypt(aesKey, plaintext, nonce);
	return concat(ephPub, nonce, aesCt);
}

/**
 * Inverse of {@link seal}. Recovers the plaintext given the worker's static
 * secret and the same resourceId. This is the operation the access worker
 * performs after the settlement gate passes; exposed here for parity testing
 * and local tooling.
 */
export function unseal(
	ciphertext: Uint8Array,
	workerSecret: Uint8Array,
	resourceId: Hex,
): Uint8Array {
	const ephPub = ciphertext.slice(0, X25519_PUBKEY_LENGTH);
	const nonce = ciphertext.slice(
		X25519_PUBKEY_LENGTH,
		X25519_PUBKEY_LENGTH + GCM_NONCE_LENGTH,
	);
	const aesCt = ciphertext.slice(X25519_PUBKEY_LENGTH + GCM_NONCE_LENGTH);
	const shared = x25519.getSharedSecret(workerSecret, ephPub);
	const aesKey = hkdfSha256(shared, undefined, sealInfo(resourceId), 32);
	return aesGcmDecrypt(aesKey, aesCt, nonce);
}

/**
 * self-hkdf-v1 seal: derive the AES key straight from the owner's own 32-byte
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

// ─── Upload / download glue ─────────────────────────────────────────────────

/**
 * The worker's error body as a message suffix (` — …`), or null when there is
 * none. A bare status code says nothing about *why* the worker refused.
 */
async function responseText(res: Response): Promise<string | null> {
	const text = await res.text().catch(() => "");
	return text ? ` — ${text.slice(0, 500)}` : null;
}

interface StorageTarget {
	/** Access-worker upload endpoint (NOT the Pinata-presign worker). */
	workerUrl: string;
	/** Bearer token the worker requires for uploads. */
	authToken: string;
	contentType: string;
}

export type EncryptAndUploadParams =
	| {
			gadget: typeof GADGET_SELF_HKDF_V1;
			plaintext: Uint8Array;
			resourceId: Hex;
			storage: StorageTarget;
			/** The owner's own 32-byte secret. */
			ownSecret: Uint8Array;
	  }
	| {
			gadget: typeof GADGET_WORKER_USDC_V1;
			plaintext: Uint8Array;
			resourceId: Hex;
			storage: StorageTarget;
			/** The access worker's static X25519 public key (32 bytes). */
			workerPubkey: Uint8Array;
	  };

/**
 * Seal `plaintext` under the chosen gadget, upload the opaque ciphertext to the
 * access worker (which writes it to R2), and return the handle describing where
 * to fetch it and how to open it.
 */
export async function encryptAndUpload(
	params: EncryptAndUploadParams,
): Promise<HandleFieldInput> {
	const { plaintext, resourceId, storage } = params;

	const ciphertext =
		params.gadget === GADGET_SELF_HKDF_V1
			? sealSelf(plaintext, params.ownSecret, resourceId)
			: seal(plaintext, params.workerPubkey, resourceId);

	// upload ciphertext to the access worker (which writes opaque bytes to R2)
	const uploadRes = await fetch(`${storage.workerUrl}/upload`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${storage.authToken}`,
			"Content-Type": storage.contentType,
		},
		body: ciphertext as unknown as BodyInit,
	});
	if (!uploadRes.ok) {
		throw new Error(
			`upload failed: HTTP ${uploadRes.status.toString()}${(await responseText(uploadRes)) ?? ""}`,
		);
	}
	const body = (await uploadRes.json().catch(() => null)) as {
		objectKey?: string;
	} | null;
	const objectKey = body?.objectKey;
	// Without this the handle carries `objectKey: undefined` and only fails much
	// later, on a read that can never resolve.
	if (!objectKey) {
		throw new Error(
			`upload succeeded but the access worker returned no objectKey: ${JSON.stringify(body)}`,
		);
	}

	return {
		"@type": "handle",
		objectKey,
		workerUrl: storage.workerUrl,
		encryption: {
			gadget: params.gadget,
			resourceId,
			ciphertextHash: sha256Hex(ciphertext),
			...(params.gadget === GADGET_WORKER_USDC_V1
				? { workerPubkey: bytesToHex(params.workerPubkey) }
				: {}),
		},
	};
}

// ─── The /access read path ──────────────────────────────────────────────────
//
// Both gadgets read through the worker's `POST /access`. The worker recovers the
// signer's (stealth) address from a personal_sign over the packed message,
// checks the Settlement Registry, and streams R2 bytes back:
//
//   self-hkdf-v1   the resource is priced 0 (free), so any signed request
//                  passes; the bytes come back still HKDF-sealed and the caller
//                  unseals them locally with `ownSecret`.
//   worker-usdc-v1 the resource is priced > 0; the worker only streams once the
//                  signer has settled, having unsealed with its own key — the
//                  bytes come back as plaintext.

/** Anything that can personal_sign a raw 32-byte hash (viem LocalAccount / WalletClient). */
export interface AccessSigner {
	signMessage(args: { message: { raw: Hex } }): Promise<Hex>;
}

export interface AccessRequest {
	nullifier: Hex;
	resourceId: Hex;
	objectKey: string;
	timestamp: number;
	signature: Hex;
}

/**
 * The message the worker recovers the stealth address from — must match
 * `buildMessageHash` in the worker byte-for-byte:
 *   keccak256(abi.encodePacked(uint256 nullifier, bytes32 resourceId, string objectKey, uint64 timestamp))
 */
export function accessMessageHash(
	nullifier: Hex,
	resourceId: Hex,
	objectKey: string,
	timestamp: number,
): Hex {
	return keccak256(
		encodePacked(
			["uint256", "bytes32", "string", "uint64"],
			[BigInt(nullifier), resourceId, objectKey, BigInt(timestamp)],
		),
	);
}

/** Sign the packed message so the worker can recover the settling stealth address. */
export async function buildAccessRequest(params: {
	signer: AccessSigner;
	nullifier: Hex;
	resourceId: Hex;
	objectKey: string;
	/** Unix seconds; defaults to now. Must be inside the worker's TIMESTAMP_WINDOW. */
	timestamp?: number;
}): Promise<AccessRequest> {
	const timestamp = params.timestamp ?? Math.floor(Date.now() / 1000);
	const hash = accessMessageHash(
		params.nullifier,
		params.resourceId,
		params.objectKey,
		timestamp,
	);
	const signature = await params.signer.signMessage({ message: { raw: hash } });
	return {
		nullifier: params.nullifier,
		resourceId: params.resourceId,
		objectKey: params.objectKey,
		timestamp,
		signature,
	};
}

export interface DecryptHandleParams {
	handle: HandleFieldInput;
	/** Signs the /access request; its address is what the worker checks settlement for. */
	signer: AccessSigner;
	/** Per-read nullifier (replay/anonymity); passed through to the worker. */
	nullifier: Hex;
	/** self-hkdf-v1 only: the same 32-byte secret used to seal. */
	ownSecret?: Uint8Array;
}

/**
 * Resolve a {@link HandleFieldInput} back to plaintext via the worker's
 * settlement-gated `POST /access`.
 *
 *   self-hkdf-v1   bytes come back sealed → verify hash → unseal with ownSecret.
 *   worker-usdc-v1 the worker already unsealed → bytes are plaintext.
 */
export async function decryptHandle(
	params: DecryptHandleParams,
): Promise<Uint8Array> {
	const { handle, signer, nullifier } = params;
	const { gadget, resourceId, ciphertextHash } = handle.encryption;

	const access = await buildAccessRequest({
		signer,
		nullifier,
		resourceId,
		objectKey: handle.objectKey,
	});

	const res = await fetch(`${handle.workerUrl}/access`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(access),
	});
	if (!res.ok) {
		throw new Error(
			`access failed: HTTP ${res.status.toString()}${(await responseText(res)) ?? ""}`,
		);
	}
	const bytes = new Uint8Array(await res.arrayBuffer());

	if (gadget === GADGET_SELF_HKDF_V1) {
		if (!params.ownSecret) {
			throw new Error(`${gadget} requires ownSecret to decrypt`);
		}
		if (sha256Hex(bytes) !== ciphertextHash) {
			throw new Error("ciphertext hash mismatch");
		}
		return unsealSelf(bytes, params.ownSecret, resourceId);
	}

	// worker-usdc-v1: the worker unsealed after settlement; bytes are plaintext.
	return bytes;
}
