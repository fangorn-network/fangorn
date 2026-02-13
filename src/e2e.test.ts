import { beforeAll, describe, it, expect } from "vitest";
import { Account, createWalletClient, Hex, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "fs";
import { join } from "path";
import { deployContract } from "./deployContract.js";
import { TestBed } from "./test/testbed.js";
import { uploadToPinata } from "./test/index.js";
import { createRequire } from "module";
import { arbitrumSepolia, baseSepolia } from "viem/chains";

const getEnv = (key: string) => {
	const value = process.env[key];
	if (!value) {
		throw new Error(`Environment variable ${key} is not set`);
	}
	return value;
};

describe("payment-gated decryption", () => {
	let rpcUrl: string;
	let jwt: string;
	let gateway: string;

	let delegatorAccount: Account;
	let delegateeAccount: Account;
	let usdcContractAddress: Address;
	let dataSourceRegistryAddress: Address;
	let ipfsCid: string;
	let chainName: string;
	let usdcDomainName: string;

	let caip2: number;

	let testbed: TestBed;

	beforeAll(async () => {
		chainName = process.env.CHAIN_NAME!;
		if (!chainName) throw new Error("CHAIN_NAME required");

		usdcDomainName = process.env.USDC_DOMAIN_NAME!;
		if (!usdcDomainName) throw new Error("USDC_DOMAIN_NAME required");

		// todo: set based on chain name
		const chain = arbitrumSepolia;

		rpcUrl = process.env.CHAIN_RPC_URL!;
		if (!rpcUrl) throw new Error("CHAIN_RPC_URL required");

		jwt = process.env.PINATA_JWT!;
		if (!jwt) throw new Error("PINATA_JWT required");

		gateway = process.env.PINATA_GATEWAY!;
		if (!gateway) throw new Error("PINATA_GATEWAY required");

		caip2 = parseInt(process.env.CAIP2!);
		// if (!caip2) throw new Error("CAIP2 required");

		delegatorAccount = privateKeyToAccount(
			getEnv("DELEGATOR_ETH_PRIVATE_KEY") as Hex,
		);

		const delegatorWalletClient = createWalletClient({
			account: delegatorAccount,
			transport: http(rpcUrl),
			chain,
		});

		delegateeAccount = privateKeyToAccount(
			getEnv("DELEGATEE_ETH_PRIVATE_KEY") as Hex,
		);

		const delegateeWalletClient = createWalletClient({
			account: delegateeAccount,
			transport: http(rpcUrl),
			chain,
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
				chain,
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
			chainName,
			usdcDomainName,
			caip2,
		);
	}, 120_000); // 2 minute timeout

	// afterall => cleanup (unpin files)
	it("should create a vault with data and succeed to decrypt when the payment is settled", async () => {
		// create a vault
		const vaultName = "myVault_" + getRandomIntInclusive(0, 101010101);
		const vaultId = await testbed.setupVault(vaultName);
		console.log(`Vault creation successful, using vaultId: ${vaultId}`);

		const price = "0.000001";
		// build manifest
		const manifest = [
			{
				tag: "test0",
				data: "hello, fangorn",
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
		// sleep to avoid any pinata rate limiting
		await new Promise((f) => setTimeout(f, 6_000));
		// add more data to the vault
		const nextFiles = [
			{
				tag: "test1",
				data: "content1",
				extension: ".png",
				fileType: "image/png",
				price: "0.001",
			},
			{
				tag: "test2",
				data: "content2",
				extension: ".mp4",
				fileType: "video/mp4",
				price: "0",
			},
		];
		await testbed.fileUpload(vaultId, nextFiles);

		// purchase data access
		await testbed.payForFile(vaultId, "test1", price, delegatorAccount.address);

		// try to access the new files with the same password
		const newTag = nextFiles[0].tag;
		const newExpectedPlaintext = nextFiles[0].data;
		const actualOutput = await testbed.tryDecrypt(vaultId, newTag);
		const actualOutputAsString = new TextDecoder().decode(actualOutput);
		expect(actualOutputAsString).toBe(newExpectedPlaintext);
		console.log("Decryption succeeded again!!");
	}, 120_000);

	// it("should fail to decrypt when the payment is not settled", async () => {
	// 	// create a vault
	// 	const vaultName = "myVault_" + getRandomIntInclusive(0, 101010101);
	// 	const vaultId = await testbed.setupVault(vaultName);
	// 	console.log(`Vault creation successful, using vaultId: ${vaultId}`);

	// 	const price = "0.000001";
	// 	// build manifest
	// 	const manifest = [
	// 		{
	// 			tag: "test0",
	// 			data: "hello, fangorn",
	// 			extension: ".txt",
	// 			fileType: "text/plain",
	// 			price,
	// 		},
	// 	];

	// 	await testbed.fileUpload(vaultId, manifest);

	// 	const tag = manifest[0].tag;

	// 	// wait to make sure pinata is behaving
	// 	await new Promise((resolve) => setTimeout(resolve, 4_000));
	// 	// DO NOT PAY
	// 	let didFail = false;
	// 	try {
	// 		await testbed.tryDecrypt(vaultId, tag);
	// 	} catch (error) {
	// 		didFail = true;
	// 	}

	// 	expect(didFail).toBe(true);
	// }, 120_000);

	// it("should fail to decrypt when the tag does not exist", async () => {
	// 	// create a vault
	// 	const vaultName = "myVault_" + getRandomIntInclusive(0, 101010101);
	// 	// const vaultName = "demo";
	// 	const vaultId = await testbed.setupVault(vaultName);
	// 	console.log(`Vault creation successful, using vaultId: ${vaultId}`);

	// 	const price = "0.000001";
	// 	// build manifest
	// 	const manifest = [
	// 		{
	// 			tag: "test0",
	// 			data: "hello, fangorn",
	// 			extension: ".txt",
	// 			fileType: "text/plain",
	// 			price,
	// 		},
	// 	];

	// 	await testbed.fileUpload(vaultId, manifest);
	// 	// wait to make sure pinata is behaving
	// 	await new Promise((resolve) => setTimeout(resolve, 5_000));
	// 	// try to get the data associated with the wrong (vault, tag) combo
	// 	let didFail = false;
	// 	try {
	// 		await testbed.tryDecrypt(vaultId, "bad-tag-do-not-use");
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
