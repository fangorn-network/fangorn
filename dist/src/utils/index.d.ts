import { type Address, Hex } from "viem";
export declare function hashPassword(password: string): Hex;
export declare function deriveVaultId(
	passwordHash: `0x${string}`,
	owner: Address,
): `0x${string}`;
export declare function poseidon1Hash(input: bigint): Promise<bigint>;
export declare function poseidon2Hash(
	left: bigint,
	right: bigint,
): Promise<bigint>;
export declare function stringToBytes32Array(str: string): number[];
export declare function hexToBytes32Array(hex: `0x${string}`): number[];
export declare function addressToBytes32Array(address: Address): number[];
