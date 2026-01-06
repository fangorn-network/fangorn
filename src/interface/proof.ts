import { Hex, keccak256, toBytes } from "viem";
import { VaultEntry, VaultManifest } from "./types.js";
import { blake3 } from "@noble/hashes/blake3.js";

import { poseidon1Hash, poseidon2Hash } from "./utils.js";
import { fieldToHex, getProof, hexToField } from "./merkle.js";
const TREE_DEPTH = 8;

// export async function buildCircuitInputs(
// 	password: string,
// 	entry: VaultEntry,
// 	userAddress: `0x${string}`,
// 	vaultId: `0x${string}`,
// 	manifest: VaultManifest,
// ): Promise<{
// 	inputs: Record<string, any>;
// 	nullifier: `0x${string}`;
// 	cidCommitment: `0x${string}`;
// }> {
// 	const layers = manifest.tree!.map((layer) => layer.map(hexToField));
// 	const { path, indices } = getProof(layers, Number(entry.index));

// 	const cidLeaf = BigInt(entry.leaf);

// 	// Compute CID commitment
// 	const cidCommitment = await poseidon1Hash(cidLeaf);
// 	console.log("✓ CID commitment:", fieldToHex(cidCommitment));

// 	// Verify merkle root locally
// 	let current = cidLeaf;
// 	for (let i = 0; i < TREE_DEPTH; i++) {
// 		const sibling = path[i];
// 		const isRight = indices[i] === 1;
// 		const [left, right] = isRight ? [sibling, current] : [current, sibling];
// 		current = await poseidon2Hash(left, right);
// 	}
// 	const expectedRoot = BigInt(manifest.poseidon_root);
// 	if (current !== expectedRoot) {
// 		throw new Error(
// 			`Merkle root mismatch: computed ${current}, expected ${expectedRoot}`,
// 		);
// 	}
// 	console.log("✓ Merkle root verified");

// 	// Password (padded to 32 bytes)
// 	const passwordBytes = new Uint8Array(32);
// 	passwordBytes.set(new TextEncoder().encode(password).slice(0, 32));
// 	const expectedHash = keccak256(passwordBytes);

// 	// User address (left-padded to 32 bytes)
// 	const userAddressBytes = new Uint8Array(32);
// 	const addrBytes = Buffer.from(userAddress.slice(2), "hex");
// 	userAddressBytes.set(addrBytes, 32 - addrBytes.length);

// 	// Vault ID (32 bytes)
// 	const vaultIdBytes = new Uint8Array(32);
// 	const vaultBytes = Buffer.from(vaultId.slice(2), "hex");
// 	vaultIdBytes.set(vaultBytes, 32 - vaultBytes.length);

// 	// CID leaf as big-endian bytes
// 	const cidBytes = new Uint8Array(32);
// 	let temp = cidLeaf;
// 	for (let i = 31; i >= 0; i--) {
// 		cidBytes[i] = Number(temp & 0xffn);
// 		temp = temp >> 8n;
// 	}

// 	// Nullifier = blake3(password || user_address || vault_id || cid)
// 	const nullifierInput = new Uint8Array(128);
// 	nullifierInput.set(passwordBytes, 0);
// 	nullifierInput.set(userAddressBytes, 32);
// 	nullifierInput.set(vaultIdBytes, 64);
// 	nullifierInput.set(cidBytes, 96);
// 	const nullifierHash = blake3(nullifierInput);
// 	const nullifier =
// 		`0x${Buffer.from(nullifierHash).toString("hex")}` as `0x${string}`;

// 	const expectedHashBytes = Array.from(
// 		Buffer.from(expectedHash.slice(2), "hex"),
// 	);
// 	const nullifierBytesArr = Array.from(nullifierHash);

// 	return {
// 		inputs: {
// 			// Private
// 			password: Array.from(passwordBytes),
// 			merkle_path: path.map((p) => p.toString()),
// 			merkle_indices: indices.map((i) => i.toString()),
// 			// Public
// 			expected_hash: expectedHashBytes,
// 			merkle_root: expectedRoot.toString(),
// 			user_address: Array.from(userAddressBytes),
// 			vault_id: Array.from(vaultIdBytes),
// 			nullifier: nullifierBytesArr,
// 			// the actual CID is private
// 			cid_commitment: cidLeaf.toString(),
// 		},
// 		nullifier,
// 		cidCommitment: fieldToHex(cidCommitment),
// 	};
// }

export async function buildCircuitInputs(
	password: string,
	entry: VaultEntry,
	userAddress: `0x${string}`,
	vaultId: `0x${string}`,
	manifest: VaultManifest,
): Promise<{
	inputs: Record<string, any>;
	nullifier: `0x${string}`;
	cidCommitment: `0x${string}`;
}> {
	const layers = manifest.tree!.map((layer) => layer.map(hexToField));
	const { path, indices } = getProof(layers, Number(entry.index));

	// cid_commitment IS the leaf (no extra hash)
	const cidCommitment = hexToField(entry.leaf);
	console.log("✓ CID commitment:", fieldToHex(cidCommitment));

	// Verify merkle root locally
	let current = cidCommitment; // Use cidCommitment, not cidLeaf
	for (let i = 0; i < TREE_DEPTH; i++) {
		const sibling = path[i];
		const isRight = indices[i] === 1;
		const [left, right] = isRight ? [sibling, current] : [current, sibling];
		current = await poseidon2Hash(left, right);
	}
	const expectedRoot = hexToField(manifest.poseidon_root);
	if (current !== expectedRoot) {
		throw new Error(
			`Merkle root mismatch: computed ${current}, expected ${expectedRoot}`,
		);
	}
	console.log("✓ Merkle root verified");

	// Password (padded to 32 bytes)
	const passwordBytes = new Uint8Array(32);
	passwordBytes.set(new TextEncoder().encode(password).slice(0, 32));
	const expectedHash = keccak256(passwordBytes);

	// User address (left-padded to 32 bytes)
	const userAddressBytes = new Uint8Array(32);
	const addrBytes = Buffer.from(userAddress.slice(2), "hex");
	userAddressBytes.set(addrBytes, 32 - addrBytes.length);

	// Vault ID (32 bytes)
	const vaultIdBytes = new Uint8Array(32);
	const vaultBytes = Buffer.from(vaultId.slice(2), "hex");
	vaultIdBytes.set(vaultBytes, 32 - vaultBytes.length);

	// CID commitment as big-endian bytes (for nullifier)
	const cidBytes = new Uint8Array(32);
	let temp = cidCommitment;
	for (let i = 31; i >= 0; i--) {
		cidBytes[i] = Number(temp & 0xffn);
		temp = temp >> 8n;
	}

	// Nullifier = blake3(password || user_address || vault_id || cid_commitment)
	const nullifierInput = new Uint8Array(128);
	nullifierInput.set(passwordBytes, 0);
	nullifierInput.set(userAddressBytes, 32);
	nullifierInput.set(vaultIdBytes, 64);
	nullifierInput.set(cidBytes, 96);
	const nullifierHash = blake3(nullifierInput);
	const nullifier =
		`0x${Buffer.from(nullifierHash).toString("hex")}` as `0x${string}`;

	const expectedHashBytes = Array.from(
		Buffer.from(expectedHash.slice(2), "hex"),
	);
	const nullifierBytesArr = Array.from(nullifierHash);

	return {
		inputs: {
			// Private
			password: Array.from(passwordBytes),
			merkle_path: path.map((p) => p.toString()),
			merkle_indices: indices.map((i) => i.toString()),
			// Public
			expected_hash: expectedHashBytes,
			merkle_root: expectedRoot.toString(),
			user_address: Array.from(userAddressBytes),
			vault_id: Array.from(vaultIdBytes),
			nullifier: nullifierBytesArr,
			cid_commitment: cidCommitment.toString(),
		},
		nullifier,
		cidCommitment: fieldToHex(cidCommitment),
	};
}

// create a commitment to the (vaultId, tag) combo using poseidon2
export async function computeTagCommitment(
	vaultId: string,
	tag: string,
): Promise<bigint> {
	const vaultIdBigInt = BigInt(vaultId);

	// Convert tag to field
	const tagBytes = new TextEncoder().encode(tag);
	let tagField = 0n;
	for (let i = 0; i < Math.min(tagBytes.length, 31); i++) {
		tagField = (tagField << 8n) | BigInt(tagBytes[i]);
	}

	const hash = await poseidon2Hash(vaultIdBigInt, tagField);
	return hash;
}
