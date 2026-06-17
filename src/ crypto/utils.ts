// // src/utils.ts
// import { blake3 } from "@noble/hashes/blake3.js";
// import { CompiledCircuit, Noir } from "@noir-lang/noir_js";
// import {
// 	keccak256,
// 	encodeAbiParameters,
// 	parseAbiParameters,
// 	type Address,
// 	Hex,
// } from "viem";

// // import poseidaon1Circuit from "../../circuits/poseiden1_hash/target/poseiden1_hash.json";
// import poseidon2Circuit from "../circuits/poseiden2_hash/target/poseiden2_hash.json";
// import { ManifestEntry } from "../roles/publisher";

// // The Prime Field Modulus for BN254
// const MODULUS =
// 	21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// export async function poseidon2Hash(
// 	left: bigint,
// 	right: bigint,
// ): Promise<bigint> {
// 	const poseidonCircuit2 = (poseidon2Circuit as unknown) as CompiledCircuit;
// 	const noir = new Noir(poseidonCircuit2);
// 	// ensure both inputs are < MODULUS
// 	const safeLeft = ((left % MODULUS) + MODULUS) % MODULUS;
// 	const safeRight = ((right % MODULUS) + MODULUS) % MODULUS;

// 	const { returnValue } = await noir.execute({
// 		value1: safeLeft.toString(),
// 		value2: safeRight.toString(),
// 	});

// 	return BigInt(returnValue as string);
// }

// // String to 32-byte array
// export function stringToBytes32Array(str: string): number[] {
// 	const padded = str.padEnd(32, "\0");
// 	return Array.from(new TextEncoder().encode(padded)).slice(0, 32);
// }

// // Hex string (0x...) to 32-byte array
// export function hexToBytes32Array(hex: `0x${string}`): number[] {
// 	const clean = hex.slice(2);
// 	const padded = clean.padStart(64, "0"); // Ensure 32 bytes
// 	return Array.from(Buffer.from(padded, "hex"));
// }

// // Address (20 bytes) to 32-byte array, left-padded!!
// export function addressToBytes32Array(address: Address): number[] {
// 	const clean = address.slice(2).toLowerCase();
// 	const bytes20 = Array.from(Buffer.from(clean, "hex"));
// 	const padding = new Array(12).fill(0);
// 	return [...padding, ...bytes20];
// }
