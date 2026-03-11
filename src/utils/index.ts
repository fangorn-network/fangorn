import {
	keccak256,
	encodeAbiParameters,
	parseAbiParameters,
	type Address,
	Hex,
	encodePacked,
} from "viem";

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
