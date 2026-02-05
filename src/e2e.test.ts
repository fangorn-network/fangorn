import { beforeAll, describe, it, expect } from "vitest";
import { Account, createWalletClient, Hex, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "fs";
import { join } from "path";
import { deployContract } from "./deployContract.js";
import { TestBed } from "./test/testbed.js";
import { uploadToPinata } from "./test/index.js";
import { createRequire } from "module";
import { baseSepolia } from "viem/chains";
import { computeTagCommitment } from "./crypto/proof.js";
import { fieldToHex } from "./crypto/merkle.js";

const require = createRequire(import.meta.url);
const circuit = require("../circuits/preimage/target/preimage.json");

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
	let usdcContractAddress: Address;
	let dataSourceRegistryAddress: Address;
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

		const delegatorWalletClient = createWalletClient({
			account: delegatorAccount,
			transport: http(rpcUrl),
			chain: baseSepolia,
		});

		delegateeAccount = privateKeyToAccount(
			getEnv("DELEGATEE_ETH_PRIVATE_KEY") as Hex,
		);

		const delegateeWalletClient = createWalletClient({
			account: delegateeAccount,
			transport: http(rpcUrl),
			chain: baseSepolia,
		});

		// if the cid is not defined, add the lit action to ipfs
		ipfsCid = process.env.LIT_ACTION_CID!;
		if (!ipfsCid) {
			console.log("Uploading Verifier Lit Action to Pinata");
			// q: should it verify if it is the right lit action?
			const litActionCode = readFileSync(
				join(__dirname, "./lit-actions/litAction.js"),
				"utf-8",
			);
			ipfsCid = await uploadToPinata("lit-action.js", litActionCode);
		}

		usdcContractAddress = process.env.USDC_CONTRACT_ADDRESS! as Address;
		dataSourceRegistryAddress = process.env.DS_REGISTRY_ADDR! as Address;
		// deploy valid contracts if either are undefined
		if (!dataSourceRegistryAddress) {
			console.log("Deploying DSRegistry Contract");
			const deployment = await deployContract({
				account: delegatorAccount,
				contractName: "DSRegistry",
				constructorArgs: [usdcContractAddress],
			});
			dataSourceRegistryAddress = deployment.address;
		}

		console.log(`Lit Action CID: ${ipfsCid}`);
		console.log(`Data Source Registry Contract: ${dataSourceRegistryAddress}`);

		testbed = await TestBed.init(
			delegatorWalletClient,
			delegateeWalletClient,
			jwt,
			gateway,
			ipfsCid,
			dataSourceRegistryAddress,
			usdcContractAddress,
			rpcUrl,
		);
	}, 120_000); // 2 minute timeout

	// afterall => cleanup (unpin files)
	it("should create a vault with data and succeed to decrypt when the payment is settled", async () => {
		// create a vault
		const vaultName = "myVault_" + getRandomIntInclusive(0, 101010101);
		// const vaultName = "demo";
		const vaultId = await testbed.setupVault(vaultName);
		console.log(`Vault creation successful, using vaultId: ${vaultId}`);

		const price = "0.000001";
		// build manifest
		const manifest = [
			{
				tag: "test0",
				data: "content0",
				extension: ".txt",
				fileType: "text/plain",
				price,
			},
		];

		await testbed.fileUpload(vaultId, manifest);

		const tag = manifest[0].tag;
		// purchase data access
		await testbed.payForFile(vaultId, tag, price, delegatorAccount.address);

		// wait to make sure pinata is behaving
		await new Promise((resolve) => setTimeout(resolve, 10_000));

		// try to get the data associated with the (vault, tag) combo
		const expectedPlaintext = manifest[0].data;
		const output = await testbed.tryDecrypt(vaultId, tag);
		const outputAsString = new TextDecoder().decode(output);
		expect(outputAsString).toBe(expectedPlaintext);
		console.log("Decryption succeeded!");

		// // sleep to avoid any pinata rate limiting
		// await new Promise((f) => setTimeout(f, 6000));
		// // add more data to the vault
		// const nextFiles = [
		// 	{
		// 		tag: "test1",
		// 		data: "content1",
		// 		extension: ".png",
		// 		fileType: "image/png",
		// 		price: "0.001",
		// 	},
		// 	{
		// 		tag: "test2",
		// 		data: "content2",
		// 		extension: ".mp4",
		// 		fileType: "video/mp4",
		// 		price: "0",
		// 	},
		// ];
		// await testbed.fileUpload(nextFiles);

		// // try to access the new files with the same password
		// const newTag = nextFiles[0].tag;
		// const newExpectedPlaintext = nextFiles[0].data;
		// const actualOutput = await testbed.tryDecrypt(vaultId, newTag);
		// const actualOutputAsString = new TextDecoder().decode(actualOutput);
		// expect(actualOutputAsString).toBe(newExpectedPlaintext);
		// console.log("Decryption succeeded again!!");
	}, 120_000);

	// it("should fail to decrypt when the password is incorrect", async () => {
	// 	// setup vault (will skip vault creation since we already have one with this name)
	// 	const vaultName = "myVault_0001";
	// 	const password = "ok";
	// 	const badPassword = "not-ok";
	// 	const vaultId = await testbed.setupVault(vaultName, password);

	// 	const manifest = [
	// 		{
	// 			tag: "test3",
	// 			data: "content3",
	// 			extension: ".txt",
	// 			fileType: "text/plain",
	// 		},
	// 	];
	// 	await testbed.fileUpload(vaultId, manifest);
	// 	// try to get the data associated with the (vault, tag) combo

	// 	let didFail = false;
	// 	try {
	// 		await testbed.tryDecrypt(vaultId, "test3", badPassword);
	// 	} catch (error) {
	// 		didFail = true;
	// 	}

	// 	expect(didFail).toBe(true);
	// }, 120_000);

	// it("should fail to decrypt when the tag does not exist", async () => {
	// 	// setup vault
	// 	const vaultName = "myVault_0001";
	// 	const password = "ok";
	// 	const vaultId = await testbed.setupVault(vaultName, password);
	// 	// try to get the data associated with the wrong (vault, tag) combo
	// 	let didFail = false;
	// 	try {
	// 		await testbed.tryDecrypt(vaultId, "bad-tag-do-not-use", password);
	// 	} catch (error) {
	// 		didFail = true;
	// 	}

	// 	expect(didFail).toBe(true);
	// }, 120_000);

	// it("should fail to decrypt when the vault does not exist", async () => {
	// 	let didFail = false;
	// 	try {
	// 		await testbed.tryDecrypt("0x0", "", "");
	// 	} catch (error) {
	// 		didFail = true;
	// 	}

	// 	expect(didFail).toBe(true);
	// }, 120_000);
});

function getRandomIntInclusive(min: number, max: number) {
	min = Math.ceil(min);
	max = Math.floor(max);
	return Math.floor(Math.random() * (max - min + 1)) + min;
}
