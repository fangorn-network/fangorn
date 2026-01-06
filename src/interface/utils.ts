// src/utils.ts
import { blake3 } from "@noble/hashes/blake3.js";
import { Noir } from "@noir-lang/noir_js";
import {
	keccak256,
	toBytes,
	encodeAbiParameters,
	parseAbiParameters,
	type Address,
	bytesToHex,
	Hex,
} from "viem";

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const poseidon1Circuit = require("../../circuits/poseiden1_hash/target/poseiden1_hash.json");
const poseidon2Circuit = require("../../circuits/poseiden2_hash/target/poseiden2_hash.json");

export function hashPassword(password: string): Hex {
	const padded = password.padEnd(32, "\0");
	const bytes = new TextEncoder().encode(padded).slice(0, 32);
	return keccak256(bytes);
}

export function computeNullifier(
	password: string,
	userAddress: Address,
	vaultId: `0x${string}`,
): `0x${string}` {
	// Must match circuit: blake3(password || user_address || vault_id)
	const passwordBytes = new TextEncoder()
		.encode(password.padEnd(32, "\0"))
		.slice(0, 32);
	const addressBytes = Buffer.from(
		userAddress.slice(2).padStart(64, "0"),
		"hex",
	);
	const vaultBytes = Buffer.from(vaultId.slice(2), "hex");

	const combined = new Uint8Array(96);
	combined.set(passwordBytes, 0);
	combined.set(addressBytes, 32);
	combined.set(vaultBytes, 64);

	const hash = blake3(combined);
	return `0x${Buffer.from(hash).toString("hex")}` as `0x${string}`;
}

export function deriveVaultId(
	passwordHash: `0x${string}`,
	owner: Address,
): `0x${string}` {
	return keccak256(
		encodeAbiParameters(parseAbiParameters("bytes32, address"), [
			passwordHash,
			owner,
		]),
	);
}

// The Prime Field Modulus for BN254
const MODULUS =
	21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export async function poseidon1Hash(input: bigint): Promise<bigint> {
	const noir = new Noir(poseidon1Circuit);
	// Ensure input is < MODULUS
	const safeInput = input < MODULUS ? input : input % MODULUS;

	const { returnValue } = await noir.execute({
		value: safeInput.toString(),
	});

	return BigInt(returnValue as string);
}

export async function poseidon2Hash(
	left: bigint,
	right: bigint,
): Promise<bigint> {
	const noir = new Noir(poseidon2Circuit);
	// Ensure both inputs are < MODULUS
	const safeLeft = left < MODULUS ? left : left % MODULUS;
	const safeRight = right < MODULUS ? right : right % MODULUS;

	const { returnValue } = await noir.execute({
		value1: safeLeft.toString(),
		value2: safeRight.toString(),
	});

	return BigInt(returnValue as string);
}

// String to 32-byte array
export function stringToBytes32Array(str: string): number[] {
	const padded = str.padEnd(32, "\0");
	return Array.from(new TextEncoder().encode(padded)).slice(0, 32);
}

// Hex string (0x...) to 32-byte array
export function hexToBytes32Array(hex: `0x${string}`): number[] {
	const clean = hex.slice(2);
	const padded = clean.padStart(64, "0"); // Ensure 32 bytes
	return Array.from(Buffer.from(padded, "hex"));
}

// Address (20 bytes) to 32-byte array, left-padded!!
export function addressToBytes32Array(address: Address): number[] {
	const clean = address.slice(2).toLowerCase();
	const bytes20 = Array.from(Buffer.from(clean, "hex"));
	const padding = new Array(12).fill(0);
	return [...padding, ...bytes20];
}
