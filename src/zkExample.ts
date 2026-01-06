// src/zkExample.ts
import { nagaDev } from "@lit-protocol/networks";
import { createLitClient } from "@lit-protocol/lit-client";
import { createAuthManager, storagePlugins } from "@lit-protocol/auth";
import {
	Account,
	Address,
	createPublicClient,
	createWalletClient,
	Hex,
	http,
} from "viem";
import { baseSepolia } from "viem/chains";
import { encryptWithZkCondition } from "./encrypt.js";
import { decrypt } from "./decrypt.js";
import { createRequire } from "module";
import { uploadToPinata } from "./uploadToIpfs.js";
import { ZKGate } from "./interface/zkGate.js";
import { hashPassword, poseidon1Hash } from "./interface/utils.js";
import { buildCircuitInputs, computeTagCommitment } from "./interface/proof.js";
import {
	buildTreeFromLeaves,
	fieldToHex,
	hexToField,
} from "./interface/merkle.js";
import { VaultEntry, VaultManifest } from "./interface/types.js";
import { Fangorn } from "./fangorn.js";
import { assert } from "console";

const require = createRequire(import.meta.url);
const circuit = require("../circuits/preimage/target/preimage.json");

export const runZkExample = async ({
	delegatorAccount,
	delegateeAccount,
	zkGateAddress,
	ipfsCid,
	rpcUrl,
	jwt,
	gateway,
}: {
	delegatorAccount: Account;
	delegateeAccount: Account;
	zkGateAddress: string;
	ipfsCid: string;
	rpcUrl: string;
	jwt: string;
	gateway: string;
}) => {
	// create fangorn client for the delegator
	const fangorn = await Fangorn.init(
		delegatorAccount,
		rpcUrl,
		zkGateAddress as Address,
		jwt,
		gateway,
	);

	// create a new vault
	const password = "test3";
	const vaultId = await fangorn.createVault(password);

	// add multiple files
	const taxTag = "tax-2025";
	const secretTaxData = "Secret Tax Data";
	await fangorn.addFile(vaultId, taxTag, secretTaxData, ipfsCid);
	await fangorn.addFile(vaultId, "passport", "passport scan", ipfsCid);
	await fangorn.addFile(vaultId, "medical", "medical records", ipfsCid);

	// commit all at once (one Merkle tree, one manifest, one tx)
	await fangorn.commitVault(vaultId);

	// Later, add another file (commitVault is called internally)
	await fangorn.addFileToExistingVault(
		vaultId,
		"new-doc",
		"new content",
		ipfsCid,
	);

	// decryption
	// build new fangorn client for the delegatee
	const fangornDelegatee = await Fangorn.init(
		delegateeAccount,
		rpcUrl,
		zkGateAddress as Address,
		jwt,
		gateway,
	);
	const plaintext = await fangornDelegatee.decryptFile(
		vaultId,
		taxTag,
		password,
		circuit,
	);
	console.log("we got the plaintext " + plaintext);

	assert(plaintext === secretTaxData);
};
