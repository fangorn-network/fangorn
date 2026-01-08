import { beforeAll, describe, it, expect } from "vitest";
import { Account, Hex, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "fs";
import { join } from "path";
import { deployContracts } from "./deployContract.js";
import { TestBed } from "./test/testbed.js";
import { PinataSDK } from "pinata";
import { uploadToPinata } from "./test/index.js";

const getEnv = (key: string) => {
	const value = process.env[key];
	if (!value) {
		throw new Error(`Environment variable ${key} is not set`);
	}
	return value;
};

describe("ZK-gated decryption", () => {
	let rpcUrl: string;
	let jwt: string;
	let gateway: string;

	let delegatorAccount: Account;
	let delegateeAccount: Account;
	let verifierContractAddress: Address;
	let zkGateAddress: Address;
	let ipfsCid: string;

	let testbed: TestBed;

	beforeAll(async () => {
		rpcUrl = process.env.CHAIN_RPC_URL!;
		if (!rpcUrl) throw new Error("CHAIN_RPC_URL required");

		jwt = process.env.PINATA_JWT!;
		if (!jwt) throw new Error("PINATA_JWT required");

		gateway = process.env.PINATA_GATEWAY!;
		if (!gateway) throw new Error("PINATA_GATEWAY required");

		delegatorAccount = privateKeyToAccount(
			getEnv("DELEGATOR_ETH_PRIVATE_KEY") as Hex,
		);

		delegateeAccount = privateKeyToAccount(
			getEnv("DELEGATEE_ETH_PRIVATE_KEY") as Hex,
		);

		// if the cid is not defined, add the lit action to ipfs
		ipfsCid = process.env.LIT_ACTION_CID!;
		if (!ipfsCid) {
			console.log("Uploading Verifier Lit Action to Pinata");
			// storage via Pinata
			const pinata = new PinataSDK({
				pinataJwt: jwt,
				pinataGateway: gateway,
			});

			// q: should it verify if it is the right lit action?
			const litActionCode = readFileSync(
				join(__dirname, "./lit-actions/litAction.js"),
				"utf-8",
			);
			ipfsCid = await uploadToPinata("lit-action.js", litActionCode);
		}

		zkGateAddress = process.env.ZK_GATE_ADDR! as Address;
		verifierContractAddress = process.env.VERIFIER_CONTRACT_ADDR! as Address;
		// deploy valid contracts if either are undefined
		if (!verifierContractAddress || !zkGateAddress) {
			console.log("Deploying Verifier Contract");
			const deployment = await deployContracts({ account: delegatorAccount });
			verifierContractAddress = deployment.verifierAddress;
			zkGateAddress = deployment.zkGateAddress;
		}

		console.log(`Lit Action CID: ${ipfsCid}`);
		console.log(`Verifier: ${verifierContractAddress}`);
		console.log(`ZKGate: ${zkGateAddress}`);

		testbed = await TestBed.init(
			delegatorAccount,
			delegateeAccount,
			zkGateAddress,
			rpcUrl,
			jwt,
			gateway,
			ipfsCid,
		);
	}, 30_000);

	// afterall => cleanup (unpin files)
	it("should create a vault with data and succeed to decrypt when the proof is valid", async () => {
		// setup vault
		const password = "ok";
		const vaultName = "myVault_0001";
		const vaultId = await testbed.setupVault(vaultName, password);
		// upload test files
		const manifest = [
			{
				tag: "test0",
				data: "content0",
				extension: ".txt",
				fileType: "text/plain",
			},
		];
		await testbed.fileUpload(vaultId, manifest);
		// try to get the data associated with the (vault, tag) combo
		const tag = manifest[0].tag;
		const expectedPlaintext = manifest[0].data;
		const output = await testbed.tryDecrypt(vaultId, tag, password);
		expect(output).toBe(expectedPlaintext);
		console.log("Decryption succeeded!");

		// add more data to the vault
		const nextFiles = [
			{
				tag: "test1",
				data: "content1",
				extension: ".png",
				fileType: "image/png",
			},
			{
				tag: "test2",
				data: "content2",
				extension: ".mp4",
				fileType: "video/mp4",
			},
		];
		await testbed.fileUpload(vaultId, nextFiles);

		// try to access the new files with the same passwodr
		const newTag = nextFiles[0].tag;
		const newExpectedPlaintext = nextFiles[0].data;
		const actualOutput = await testbed.tryDecrypt(vaultId, newTag, password);
		expect(actualOutput).toBe(newExpectedPlaintext);
		console.log("Decryption succeeded!");
	}, 120_000);

	it("should fail to decrypt when the password is incorrect", async () => {
		// setup vault (will skip vault creation since we already have one with this name)
		const vaultName = "myVault_0001";
		const password = "ok";
		const badPassword = "not-ok";
		const vaultId = await testbed.setupVault(vaultName, password);

		const manifest = [
			{
				tag: "test3",
				data: "content3",
				extension: ".txt",
				fileType: "text/plain",
			},
		];
		await testbed.fileUpload(vaultId, manifest, ipfsCid);
		// try to get the data associated with the (vault, tag) combo

		let didFail = false;
		try {
			await testbed.tryDecrypt(vaultId, "test3", badPassword);
		} catch (error) {
			didFail = true;
		}

		expect(didFail).toBe(true);
	}, 120_000);

	it("should fail to decrypt when the tag does not exist", async () => {
		// setup vault
		const vaultName = "myVault_0001";
		const password = "ok";
		const vaultId = await testbed.setupVault(vaultName, password);
		// try to get the data associated with the wrong (vault, tag) combo
		let didFail = false;
		try {
			await testbed.tryDecrypt(vaultId, "bad-tag-do-not-use", password);
		} catch (error) {
			didFail = true;
		}

		expect(didFail).toBe(true);
	}, 120_000);

	it("should fail to decrypt when the vault does not exist", async () => {
		let didFail = false;
		try {
			await testbed.tryDecrypt("0x0", "", "");
		} catch (error) {
			didFail = true;
		}

		expect(didFail).toBe(true);
	}, 120_000);
});
