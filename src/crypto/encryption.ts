import { bytesToHex } from "@noble/hashes/utils.js";
import { EncryptedData } from "../types/types";
import { getRandomValues } from "crypto";
import { getSubtleCrypto } from "./rand";

export async function encryptData(data: string | Uint8Array): Promise<{
	encryptedData: EncryptedData;
	keyMaterial: Uint8Array<ArrayBuffer>;
}> {
	const subtle = getSubtleCrypto();
	const salt = getRandomValues(new Uint8Array(16));
	const iv = getRandomValues(new Uint8Array(12));
	const keyMaterial = getRandomValues(new Uint8Array(32));
	const key = await subtle.importKey(
		"raw",
		keyMaterial,
		{ name: "AES-GCM" },
		false,
		["encrypt"],
	);

	const encodedData =
		typeof data === "string" ? new TextEncoder().encode(data) : data;

	const encryptedContent = await subtle.encrypt(
		{
			name: "AES-GCM",
			iv,
			tagLength: 128,
		},
		key,
		encodedData as Uint8Array<ArrayBuffer>,
	);

	const ciphertext = encryptedContent.slice(
		0,
		encryptedContent.byteLength - 16,
	);
	const authTag = encryptedContent.slice(encryptedContent.byteLength - 16);

	return {
		encryptedData: {
			ciphertext: new Uint8Array(ciphertext) as Uint8Array<ArrayBuffer>,
			iv,
			authTag: new Uint8Array(authTag) as Uint8Array<ArrayBuffer>,
			salt,
		},
		keyMaterial,
	};
}

export async function decryptData(
	encryptedData: EncryptedData,
	keyMaterial: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array> {
	const subtle = getSubtleCrypto();

	// Ensure these are proper Uint8Arrays (may have been serialized to JSON)
	const ciphertext = toUint8Array(encryptedData.ciphertext);
	const iv = toUint8Array(encryptedData.iv);
	const authTag = toUint8Array(encryptedData.authTag);

	const key = await subtle.importKey(
		"raw",
		keyMaterial,
		{ name: "AES-GCM" },
		false,
		["decrypt"],
	);

	const dataWithAuthTag = new Uint8Array(ciphertext.length + authTag.length);
	dataWithAuthTag.set(ciphertext, 0);
	dataWithAuthTag.set(authTag, ciphertext.length);

	const decryptedContent = await subtle.decrypt(
		{ name: "AES-GCM", iv, tagLength: 128 },
		key,
		dataWithAuthTag as Uint8Array<ArrayBuffer>,
	);

	return new Uint8Array(decryptedContent);
}

function toUint8Array(
	data: Uint8Array | Record<string, number> | number[],
): Uint8Array<ArrayBuffer> {
	if (data instanceof Uint8Array) {
		return data as Uint8Array<ArrayBuffer>;
	}
	if (Array.isArray(data)) {
		return new Uint8Array(data) as Uint8Array<ArrayBuffer>;
	}
	return new Uint8Array(Object.values(data)) as Uint8Array<ArrayBuffer>;
}
