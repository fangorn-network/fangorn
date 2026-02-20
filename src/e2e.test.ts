import { beforeAll, describe, it, expect } from "vitest";
import {
	Account,
	createWalletClient,
	Hex,
	http,
	WalletClient,
	type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "fs";
import { join } from "path";
import { deployContract } from "./deployContract.js";
import { TestBed } from "./test/testbed.js";
import { uploadToPinata } from "./test/index.js";
import { arbitrumSepolia, baseSepolia } from "viem/chains";

const getEnv = (key: string) => {
	const value = process.env[key];
	if (!value) {
		throw new Error(`Environment variable ${key} is not set`);
	}
	return value;
};

describe("Fangorn basic encryption works", () => {
	// storage secrets
	let jwt: string;
	let gateway: string;

	// accts
	let delegatorAccount: Account;
	let delegateeAccount: Account;

	// wallet clients
	let delegatorWalletClient: WalletClient;
	let delegateeWalletClient: WalletClient;

	// contracts
	let usdcContractAddress: Address;
	let dataSourceRegistryAddress: Address;
	let settlementTrackerAddress: Address;

	// chain config
	// let ipfsCid: string;
	let rpcUrl: string;
	let chainName: string;
	let usdcDomainName: string;
	let caip2: number;

	let testbed: TestBed;

	beforeAll(async () => {
		chainName = process.env.CHAIN_NAME!;
		if (!chainName) throw new Error("CHAIN_NAME required");

		usdcDomainName = chainName === "arbitrumSepolia" ? "USD Coin" : "USDC";
		const chain = usdcDomainName === "USDC" ? baseSepolia : arbitrumSepolia;

		rpcUrl = process.env.CHAIN_RPC_URL!;
		if (!rpcUrl) throw new Error("CHAIN_RPC_URL required");

		jwt = process.env.PINATA_JWT!;
		if (!jwt) throw new Error("PINATA_JWT required");

		gateway = process.env.PINATA_GATEWAY!;
		if (!gateway) throw new Error("PINATA_GATEWAY required");

		caip2 = parseInt(process.env.CAIP2!);
		if (!caip2) throw new Error("CAIP2 required");

		delegatorAccount = privateKeyToAccount(
			getEnv("DELEGATOR_ETH_PRIVATE_KEY") as Hex,
		);

		delegatorWalletClient = createWalletClient({
			account: delegatorAccount,
			transport: http(rpcUrl),
			chain,
		});

		delegateeAccount = privateKeyToAccount(
			getEnv("DELEGATEE_ETH_PRIVATE_KEY") as Hex,
		);

		delegateeWalletClient = createWalletClient({
			account: delegateeAccount,
			transport: http(rpcUrl),
			chain,
		});

		usdcContractAddress = process.env.USDC_CONTRACT_ADDRESS! as Address;

		dataSourceRegistryAddress = process.env.DS_REGISTRY_ADDR! as Address;
		// deploy valid contracts if either are undefined
		if (!dataSourceRegistryAddress) {
			console.log("Deploying DSRegistry Contract");
			const deployment = await deployContract({
				account: delegatorAccount,
				contractName: "DSRegistry",
				constructorArgs: [],
				chain,
			});
			dataSourceRegistryAddress = deployment.address;
		}

		settlementTrackerAddress = process.env.SETTLEMENT_TRACKER_ADDR! as Address;
		if (!settlementTrackerAddress) {
			console.log("Deploying Settlement Tracker Contract");
			const deployment = await deployContract({
				account: delegatorAccount,
				contractName: "SettlementTracker",
				constructorArgs: [usdcContractAddress],
				chain,
			});

			console.log("deployed settlement tracker contract");
			settlementTrackerAddress = deployment.address;
		}

		// console.log(`Lit Action CID: ${ipfsCid}`);
		console.log(`Data Source Registry Contract: ${dataSourceRegistryAddress}`);
		console.log(`Settlement Tracker Contract: ${settlementTrackerAddress}`);

		testbed = await TestBed.init(
			delegatorWalletClient,
			delegateeWalletClient,
			jwt,
			gateway,
			dataSourceRegistryAddress,
			usdcContractAddress,
			rpcUrl,
			chainName,
			"arbitrumSepolia",
			caip2,
		);
	}, 120_000);

	// TODO: afterall => cleanup (unpin files)

	it("should create a datasource, add files, and succeed to decrypt when predicates are satisfied for basic acc", async () => {
		// create a vault
		const datasourceName =
			"test_datasource_" + getRandomIntInclusive(0, 101010101);
		const id = await testbed.registerDatasource(datasourceName);

		// verify existence
		expect(
			await testbed.checkDatasourceRegistryExistence(
				delegatorAccount.address,
				datasourceName,
			),
		).toBe(true);

		console.log(`Datasource registration successful, with id: ${id}`);
		// you can only read these if you have zero balance
		const tag = "test";
		const manifest = [
			{
				tag,
				data: "Hello, Fangorn!",
				extension: ".txt",
				fileType: "text/plain",
			},
		];
		// user must have an empty wallet
		await testbed.fileUploadEmptyWallet(datasourceName, manifest);
		// the manifest should have been updated in the contract
		await testbed.checkDataExistence(
			delegatorAccount.address,
			datasourceName,
			tag,
		);
		// wait to make sure pinata is behaving
		await new Promise((resolve) => setTimeout(resolve, 4_000));

		// try to get the data associated with the (owner, name, tag) combo
		const expectedPlaintext = manifest[0].data;
		const output = await testbed.tryDecrypt(
			delegatorAccount.address,
			datasourceName,
			tag,
		);
		const outputAsString = new TextDecoder().decode(output);
		expect(outputAsString).toBe(expectedPlaintext);
		console.log("Decryption succeeded!");

		// decryption should fail if the account has a positive balance of ETH (the delegator)
		let didFail = false;
		try {
			await testbed.tryDecryptDelegator(
				delegatorAccount.address,
				datasourceName,
				tag,
			);
		} catch (error) {
			didFail = true;
		}

		expect(didFail).toBe(true);
	}, 120_000);

	// it("should create a datasource, add files, and succeed to decrypt when predicates are satisfied against on-chain state (payment settled)", async () => {
	// 	// delegator creates a vault
	// 	const datasourceName =
	// 		"test_datasource_" + getRandomIntInclusive(101010101, 111111111);
	// 	const id = await testbed.registerDatasource(datasourceName);
	// 	console.log('called register datasource');
	// 	// verify existence
	// 	expect(
	// 		await testbed.checkDatasourceRegistryExistence(
	// 			delegatorAccount.address,
	// 			datasourceName,
	// 		),
	// 	).toBe(true);
	// 	console.log(`Datasource registration successful, with id: ${id}`);

	// 	const tag = "test";
	// 	const filedata = {
	// 		tag,
	// 		data: "Hello, Fangorn!",
	// 		extension: ".txt",
	// 		fileType: "text/plain",
	// 	};

	// 	// delegator uploads data encrypted for a payment of '0.000001'
	// 	const price = "0";
	// 	await testbed.fileUploadPaymentGadget(
	// 		datasourceName,
	// 		filedata,
	// 		price,
	// 		settlementTrackerAddress,
	// 	);
	// 	// the manifest should have been updated in the contract
	// 	await testbed.checkDataExistence(
	// 		delegatorAccount.address,
	// 		datasourceName,
	// 		tag,
	// 	);
	// 	console.log("encrypted data under payment settlement condition");

	// 	console.log("submitting payment");
	// 	// pay for file (delegatee has zero funds, so the delegator buys its own file)
	// 	await testbed.payForFile(
	// 		delegatorAccount.address,
	// 		datasourceName,
	// 		tag,
	// 		price,
	// 		usdcDomainName,
	// 		settlementTrackerAddress,
	// 		delegatorWalletClient,
	// 		rpcUrl,
	// 	);

	// 	const expectedPlaintext = filedata.data;
	// 	const output = await testbed.tryDecryptDelegator(
	// 		delegatorAccount.address,
	// 		datasourceName,
	// 		tag,
	// 	);
	// 	const outputAsString = new TextDecoder().decode(output);
	// 	expect(outputAsString).toBe(expectedPlaintext);
	// 	console.log("Decryption succeeded!");

	// }, 120_000);
});

function getRandomIntInclusive(min: number, max: number) {
	min = Math.ceil(min);
	max = Math.floor(max);
	return Math.floor(Math.random() * (max - min + 1)) + min;
}
