// src/utils.ts
import { blake3 } from "@noble/hashes/blake3.js";
import { CompiledCircuit, Noir } from "@noir-lang/noir_js";
import {
	keccak256,
	encodeAbiParameters,
	parseAbiParameters,
	type Address,
	Hex,
} from "viem";

import poseidon1Circuit from "../../circuits/poseiden1_hash/target/poseiden1_hash.json" with { type: "json" };
import poseidon2Circuit from "../../circuits/poseiden2_hash/target/poseiden2_hash.json" with { type: "json" };

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
	const poseidonCircuit1 = poseidon1Circuit as CompiledCircuit;
	const noir = new Noir(poseidonCircuit1);
	// ensure input is < MODULUS
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
	const poseidonCircuit2 = poseidon2Circuit as CompiledCircuit;
	const noir = new Noir(poseidonCircuit2);
	// ensure both inputs are < MODULUS
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

export function fieldToHex(field: bigint): `0x${string}` {
	return `0x${field.toString(16).padStart(64, "0")}` as `0x${string}`;
}

export function hexToField(hex: string): bigint {
	const cleanHex = hex.startsWith("0x") ? hex : `0x${hex}`;
	return BigInt(cleanHex);
}

export function deriveDatasourceId(name: string, owner: Address): Hex {
	return keccak256(
		encodeAbiParameters(parseAbiParameters("string, address"), [name, owner]),
	);
}

// create a commitment to the (vaultId, tag) combo using poseidon2
export async function computeTagCommitment(
	owner: Address,
	name: string,
	tag: string,
	price: string,
): Promise<bigint> {
	const id = deriveDatasourceId(name, owner);
	const idBigInt = BigInt(id);

	// Convert tag to field
	const tagBytes = new TextEncoder().encode(tag);
	const priceBytes = new TextEncoder().encode(price);

	let field = 0n;

	// this is probably easier with sha256
	// the original idea is that we would be proving knowledge of the preimage with a zkp
	// which is why poseidon2 was chosen as the hash function instead
	for (let i = 0; i < Math.min(tagBytes.length, 31); i++) {
		field = (field << 8n) | BigInt(tagBytes[i]);
	}

	for (let i = 0; i < priceBytes.length; i++) {
		field = (field << 8n) | BigInt(priceBytes[i]);
	}

	const hash = await poseidon2Hash(idBigInt, field);
	return hash;
}
