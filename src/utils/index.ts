import { CompiledCircuit, Noir } from "@noir-lang/noir_js";
import {
	keccak256,
	encodeAbiParameters,
	parseAbiParameters,
	type Address,
	Hex,
	encodePacked,
} from "viem";

import poseidon2Circuit from "./poseidon2_hash.json" with { type: "json" };

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
export function computeTagCommitment(
	owner: Address,
	name: string,
	tag: string,
	price: string,
): bigint {
	const id = deriveDatasourceId(name, owner);
	const hash = keccak256(
		encodePacked(
			["bytes32", "string", "string", "string"],
			[id as `0x${string}`, name, tag, price],
		),
	);
	return BigInt(hash);
}
