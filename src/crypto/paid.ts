import { x25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import {
	bytesToHex,
	concat,
	encodeAbiParameters,
	hexToBytes,
	keccak256,
	toHex,
	type Address,
	type Hex,
} from "viem";
import type { MetadataStorage } from "../providers/storage/types.js";
import { aesGcmDecrypt, aesGcmEncrypt, GCM_NONCE_LENGTH } from "./aes.js";
import { seal, unseal, type AccessSigner } from "./encryption.js";
import { getRandomValues } from "./rand.js";

// Paid fields.
//
// Everything a publisher sells is sealed under a statement: the chain, the
// SettlementRegistry, the publisher, the repo and the repo's generation. One
// random repo key per statement; each record's key is derived from it; each
// field is encrypted under its record's key, with the statement, the record
// and the field name as associated data.
//
// The publisher deposits the repo key once per statement, sealed to a key
// server. A buyer the registry lets read a record gets that record's key; a
// buyer of the whole repo gets the repo key, and so does the publisher. The
// key server stores nothing:
// the buyer sends the deposit with the request, and the key server recomputes
// the statement from its own chain and registry, so a deposit made for
// anything else doesn't unseal.

export const GADGET_FIELD_V1 = "field-v1";

/** What a repo key is sealed under. `repo` is `repoId(name)`. */
export interface PaidScope {
	chainId: number;
	registry: Address;
	publisher: Address;
	repo: Hex;
	generation: bigint;
}

/** The repo key, sealed to a key server. Public: it goes in the repo as a record. */
export interface Deposit {
	"@type": "deposit";
	gadget: typeof GADGET_FIELD_V1;
	chainId: number;
	registry: Address;
	publisher: Address;
	repo: Hex;
	generation: string;
	keyServer: string;
	sealed: Hex;
}

/** A paid field's value in a record payload. */
export interface FieldHandle {
	"@type": "handle";
	gadget: typeof GADGET_FIELD_V1;
	generation: string;
	cid: string;
}

/** What a buyer posts to a key server's `/access`. */
export interface AccessRequest {
	publisher: Address;
	repo: Hex;
	generation: string;
	/** `recordKey(id)`, or `WHOLE_REPO` for the repo key */
	key: Hex;
	/** A throwaway X25519 public key; the reply is sealed to it. */
	readerKey: Hex;
	/** The deposit's `sealed`. */
	sealed: Hex;
	timestamp: number;
	signature: Hex;
}

const hkdf32 = (ikm: Uint8Array, info: Hex | Uint8Array) =>
	hkdf(
		sha256,
		ikm,
		undefined,
		typeof info === "string" ? hexToBytes(info) : info,
		32,
	);

export const statement = (s: PaidScope): Hex =>
	keccak256(
		encodeAbiParameters(
			[
				{ type: "string" },
				{ type: "uint256" },
				{ type: "address" },
				{ type: "address" },
				{ type: "bytes32" },
				{ type: "uint64" },
			],
			[
				"fangorn:pay:v1",
				BigInt(s.chainId),
				s.registry,
				s.publisher,
				s.repo,
				s.generation,
			],
		),
	);

const scopeOf = (
	d: Pick<
		Deposit,
		"chainId" | "registry" | "publisher" | "repo" | "generation"
	>,
): PaidScope => ({
	chainId: d.chainId,
	registry: d.registry,
	publisher: d.publisher,
	repo: d.repo,
	generation: BigInt(d.generation),
});

/**
 * A random repo key. The publisher doesn't keep it: to seal more records later,
 * it asks the key server for it (`requestKey` with `WHOLE_REPO`), like a buyer
 * of the whole repo.
 */
export const newRepoKey = (): Uint8Array => getRandomValues(new Uint8Array(32));

export const deriveRecordKey = (
	kRepo: Uint8Array,
	stmt: Hex,
	key: Hex,
): Uint8Array =>
	hkdf32(kRepo, concat([stmt, key, toHex("fangorn:record-key")]));

const fieldAad = (stmt: Hex, key: Hex, field: string) =>
	hexToBytes(concat([stmt, key, toHex(field)]));

/** `nonce(12) || AES-256-GCM(kRecord, plaintext, aad = stmt || key || field)` */
export function encryptField(
	kRecord: Uint8Array,
	plaintext: Uint8Array,
	stmt: Hex,
	key: Hex,
	field: string,
): Uint8Array {
	const nonce = getRandomValues(new Uint8Array(GCM_NONCE_LENGTH));
	const ct = aesGcmEncrypt(
		kRecord,
		plaintext,
		nonce,
		fieldAad(stmt, key, field),
	);
	const out = new Uint8Array(nonce.length + ct.length);
	out.set(nonce);
	out.set(ct, nonce.length);
	return out;
}

export function decryptField(
	kRecord: Uint8Array,
	ciphertext: Uint8Array,
	stmt: Hex,
	key: Hex,
	field: string,
): Uint8Array {
	return aesGcmDecrypt(
		kRecord,
		ciphertext.slice(GCM_NONCE_LENGTH),
		ciphertext.slice(0, GCM_NONCE_LENGTH),
		fieldAad(stmt, key, field),
	);
}

export function makeDeposit(p: {
	kRepo: Uint8Array;
	keyServerPubkey: Uint8Array;
	keyServer: string;
	scope: PaidScope;
}): Deposit {
	const { scope } = p;
	return {
		"@type": "deposit",
		gadget: GADGET_FIELD_V1,
		chainId: scope.chainId,
		registry: scope.registry,
		publisher: scope.publisher,
		repo: scope.repo,
		generation: scope.generation.toString(),
		keyServer: p.keyServer,
		sealed: bytesToHex(seal(p.kRepo, p.keyServerPubkey, statement(scope))),
	};
}

/** Encrypt one field, upload the ciphertext, and return the handle that replaces the value. */
export async function sealField(p: {
	plaintext: Uint8Array;
	kRepo: Uint8Array;
	scope: PaidScope;
	/** `recordKey(id)` */
	key: Hex;
	field: string;
	storage: Pick<MetadataStorage, "putFile">;
}): Promise<FieldHandle> {
	const stmt = statement(p.scope);
	const ct = encryptField(
		deriveRecordKey(p.kRepo, stmt, p.key),
		p.plaintext,
		stmt,
		p.key,
		p.field,
	);
	return {
		"@type": "handle",
		gadget: GADGET_FIELD_V1,
		generation: p.scope.generation.toString(),
		cid: await p.storage.putFile(ct, `${p.key}.${p.field}`),
	};
}

// ── /access ──

/** What the reader signs (EIP-191, raw): the statement, the key asked for, the reply key and the time. */
export const accessMessage = (
	stmt: Hex,
	key: Hex,
	readerKey: Hex,
	timestamp: number,
): Hex =>
	keccak256(
		encodeAbiParameters(
			[
				{ type: "string" },
				{ type: "bytes32" },
				{ type: "bytes32" },
				{ type: "bytes32" },
				{ type: "uint64" },
			],
			["fangorn:access:v1", stmt, key, readerKey, BigInt(timestamp)],
		),
	);

export async function buildAccessRequest(p: {
	signer: AccessSigner;
	deposit: Deposit;
	key: Hex;
	readerKey: Hex;
	/** unix seconds; defaults to now */
	timestamp?: number;
}): Promise<AccessRequest> {
	const { deposit, key, readerKey } = p;
	const timestamp = p.timestamp ?? Math.floor(Date.now() / 1000);
	const raw = accessMessage(
		statement(scopeOf(deposit)),
		key,
		readerKey,
		timestamp,
	);
	return {
		publisher: deposit.publisher,
		repo: deposit.repo,
		generation: deposit.generation,
		key,
		readerKey,
		sealed: deposit.sealed,
		timestamp,
		signature: await p.signer.signMessage({ message: { raw } }),
	};
}

/** Ask the deposit's key server for `key`'s key: the record key, or the repo key for `WHOLE_REPO`. */
export async function requestKey(p: {
	deposit: Deposit;
	key: Hex;
	signer: AccessSigner;
	fetch?: typeof globalThis.fetch;
}): Promise<Uint8Array> {
	const secret = x25519.utils.randomSecretKey();
	const req = await buildAccessRequest({
		signer: p.signer,
		deposit: p.deposit,
		key: p.key,
		readerKey: bytesToHex(x25519.getPublicKey(secret)),
	});
	const res = await (p.fetch ?? fetch)(`${p.deposit.keyServer}/access`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(req),
	});
	if (!res.ok)
		throw new Error(
			`key server refused: ${res.status.toString()} ${await res.text()}`,
		);
	const { sealed } = (await res.json()) as { sealed: Hex };
	return unseal(hexToBytes(sealed), secret, statement(scopeOf(p.deposit)));
}

/** Get the record's key, fetch the field's ciphertext and decrypt it. */
export async function openField(p: {
	handle: FieldHandle;
	deposit: Deposit;
	/** `recordKey(id)` */
	key: Hex;
	field: string;
	signer: AccessSigner;
	storage: Pick<MetadataStorage, "getFile">;
	fetch?: typeof globalThis.fetch;
}): Promise<Uint8Array> {
	if (p.handle.generation !== p.deposit.generation)
		throw new Error("the handle and the deposit are for different generations");
	const [kRecord, ct] = await Promise.all([
		requestKey({
			deposit: p.deposit,
			key: p.key,
			signer: p.signer,
			fetch: p.fetch,
		}),
		p.storage.getFile(p.handle.cid),
	]);
	return decryptField(
		kRecord,
		ct,
		statement(scopeOf(p.deposit)),
		p.key,
		p.field,
	);
}
