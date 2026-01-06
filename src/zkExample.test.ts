import { beforeAll, describe, it, expect } from "vitest";
import {
	Account,
	encodeFunctionData,
	Hex,
	parseEther,
	toHex,
	type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { uploadToPinata } from "./uploadToIpfs.js";
import { deployContracts } from "./deployContract.js";
import { runZkExample } from "./zkExample.js";
import { createRequire } from "module";

// Import everything to see what's available
import * as acvm from "@noir-lang/acvm_js";
import * as noirc from "@noir-lang/noirc_abi";
const require = createRequire(import.meta.url);

// Load WASM as bytes
const acvmWasm = readFileSync(
	require.resolve("@noir-lang/acvm_js/web/acvm_js_bg.wasm"),
);
const noircWasm = readFileSync(
	require.resolve("@noir-lang/noirc_abi/web/noirc_abi_wasm_bg.wasm"),
);

// wasm-bindgen generated code often uses __wbg_init or initSync
const initAcvm =
	(acvm as any).__wbg_init || (acvm as any).initSync || (acvm as any).default;
const initNoirc =
	(noirc as any).__wbg_init ||
	(noirc as any).initSync ||
	(noirc as any).default;

if (typeof initAcvm === "function") {
	await initAcvm(acvmWasm);
}
if (typeof initNoirc === "function") {
	await initNoirc(noircWasm);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const getEnv = (key: string) => {
	const value = process.env[key];
	if (!value) {
		throw new Error(`Environment variable ${key} is not set`);
	}
	return value;
};

// const doDeploy = false;

describe("ZK-gated decryption", () => {
	let rpcUrl: string;
	let jwt: string;
	let gateway: string;

	let delegatorAccount: Account;
	let delegateeAccount: Account;
	let verifierContractAddress: Address;
	let zkGateAddress: Address;
	let ipfsCid: string;

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

		// if (doDeploy) {
		// 	// upload lit action
		// 	// Upload the Lit Action to IPFS
		// 	console.log("\n=== Uploading Verifier Lit Action to IPFS ===");
		// 	const litActionCode = readFileSync(
		// 		join(__dirname, "./lit-actions/litAction.js"),
		// 		"utf-8",
		// 	);
		// 	ipfsCid = await uploadToPinata("lit-action.js", litActionCode);

		// 	// Deploy the Verifier contract
		// 	console.log("\n=== Deploying Verifier Contract ===");
		// 	// deploy contracts
		// 	const deployment = await deployContracts({ account: delegatorAccount });
		// 	verifierContractAddress = deployment.verifierAddress;
		// 	zkGateAddress = deployment.zkGateAddress;
		// } else {
		ipfsCid = process.env.LIT_ACTION_CID!;
		verifierContractAddress = process.env.VERIFIER_CONTRACT_ADDR! as Address;
		zkGateAddress = process.env.ZK_GATE_ADDR! as Address;
		// }

		// verifierAbi = deployment.verifierAbi;
		// zkGateAbi = deployment.zkGateAbi;

		console.log(`Lit Action CID: ${ipfsCid}`);
		console.log(`Verifier: ${verifierContractAddress}`);
		console.log(`ZKGate: ${zkGateAddress}`);
	}, 30000); // 30s timeout for deployment

	it("should fail to decrypt when the proof is invalid (bad password)", async () => {
		let didFail = false;

		try {
			await runZkExample({
				delegatorAccount,
				delegateeAccount,
				zkGateAddress,
				ipfsCid,
				rpcUrl,
				jwt,
				gateway,
				delegatorPassword: "ok",
				delegateePassword: "NOT ok"
			});
		} catch (error) {
			didFail = true;
			console.log("Decryption failed  as expected:", error);
		}

		expect(didFail).toBe(true);
	}, 120_000);

	it("should succeed to decrypt when the proof is valid", async () => {
		console.log("\n=== Testing via Lit Action ===");

		await runZkExample({
			delegatorAccount,
			delegateeAccount,
			zkGateAddress,
			ipfsCid,
			rpcUrl,
			jwt,
			gateway,
			delegatorPassword: "ok-valid-test",
			delegateePassword: "ok-valid-test"
		});

		console.log("Decryption succeeded!");
	}, 120_000);
});
