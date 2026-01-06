// src/decrypt.ts
import { Barretenberg, UltraHonkBackend } from "@aztec/bb.js";
import { CompiledCircuit, Noir } from "@noir-lang/noir_js";
import { type Hex, toHex } from "viem";
import { ZKGate } from "./interface/zkGate.js";

export interface DecryptParams {
	// Clients
	litClient: any;
	cidCommitment: any;
	zkGate: ZKGate;

	// Vault info
	vaultId: `0x${string}`;
	nullifier: `0x${string}`;

	// Circuit
	circuit: CompiledCircuit;
	privateInputs: Record<string, any>;

	// LIT
	ciphertext: any;
	accessControlConditions: any;
	authContext: any;
}

export interface DecryptResult {
	txHash: Hex;
	txReceipt: any;
	decryptedData: any;
}

export async function decrypt(params: DecryptParams): Promise<DecryptResult> {
	const {
		litClient,
		cidCommitment,
		zkGate: zkgate,
		vaultId,
		nullifier,
		circuit,
		privateInputs,
		ciphertext,
		accessControlConditions,
		authContext,
	} = params;

	const proofHex = await generateProof(circuit, privateInputs);

	// submit proof onchain
	const submitHash = await zkgate.submitProof(
		vaultId,
		cidCommitment as Hex,
		nullifier,
		proofHex,
	);
	const txReceipt = await zkgate.waitForTransaction(submitHash);
	if (txReceipt.status !== "success") {
		throw new Error(`Transaction failed: ${txReceipt.status}`);
	}

	// try to decrypt
	const decryptedResponse = await litClient.decrypt({
		ciphertext: ciphertext.ciphertext,
		dataToEncryptHash: ciphertext.dataToEncryptHash,
		unifiedAccessControlConditions: accessControlConditions,
		authContext,
		chain: "baseSepolia",
	});

	return {
		txHash: submitHash,
		txReceipt,
		decryptedData: decryptedResponse.decryptedData,
	};
}

// Convenience function for just generating the proof without submitting
export async function generateProof(
	circuit: CompiledCircuit,
	privateInputs: Record<string, any>,
): Promise<Hex> {
	const api = await Barretenberg.new({ threads: 1 });
	const backend = new UltraHonkBackend(circuit.bytecode, api);
	const noir = new Noir(circuit);
	const { witness } = await noir.execute(privateInputs);
	const proofResult = await backend.generateProof(witness, {
		verifierTarget: "evm",
	});
	const proofHex: Hex = toHex(proofResult.proof);

	return proofHex;
}
