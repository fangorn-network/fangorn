// import { Hex, type Address } from "viem";
// import { privateKeyToAccount } from "viem/accounts";
// import { readFileSync } from "fs";
// import { dirname, join } from "path";
// import { deployContract, deployContracts } from "./src/deployContract.js";
// import { uploadToPinata } from "./src/test/index.js";
// import circuit from "./circuits/preimage/target/preimage.json" with { type: "json" };
// import { fileURLToPath } from "url";

// //**
// // deploy script that looks at your .env to determine what needs to be deployed/uploaded.
// //*/
// const __filename = fileURLToPath(import.meta.url);
// const __dirname = dirname(__filename);

// const getEnv = (key: string) => {
// 	const value = process.env[key];
// 	if (!value) {
// 		throw new Error(`Environment variable ${key} is not set`);
// 	}
// 	return value;
// };

// let rpcUrl = process.env.CHAIN_RPC_URL!;
// if (!rpcUrl) throw new Error("CHAIN_RPC_URL required");

// let jwt = process.env.PINATA_JWT!;
// if (!jwt) throw new Error("PINATA_JWT required");

// let gateway = process.env.PINATA_GATEWAY!;
// if (!gateway) throw new Error("PINATA_GATEWAY required");

// let deployerAccount = privateKeyToAccount(
// 	getEnv("DELEGATEE_ETH_PRIVATE_KEY") as Hex,
// );

// // if the cid is not defined, add the lit action to ipfs
// let ipfsCid = process.env.LIT_ACTION_CID!;
// if (!ipfsCid) {
// 	console.log("Uploading Verifier Lit Action to Pinata");
// 	// q: should it verify if it is the right lit action?
// 	const litActionCode = readFileSync(
// 		join(__dirname, "./src/lit-actions/litAction.js"),
// 		"utf-8",
// 	);
// 	ipfsCid = await uploadToPinata("lit-action.js", litActionCode);
// }

// let zkGateAddress = process.env.ZK_GATE_ADDR! as Address;
// let verifierContractAddress = process.env.VERIFIER_CONTRACT_ADDR! as Address;
// // deploy valid contracts if either are undefined
// if (!verifierContractAddress || !zkGateAddress) {
// 	console.log("Deploying Verifier Contract");
// 	const deployment = await deployContract({ account: deployerAccount, contractName: "" });
// 	verifierContractAddress = deployment.verifierAddress;
// 	zkGateAddress = deployment.zkGateAddress;
// 	console.log("Uploading circuit.json to Pinata");
// }

// let circuitIpfsCid = process.env.CIRCUIT_IPFS_CID;
// if (!circuitIpfsCid)
// 	circuitIpfsCid = await uploadToPinata("preimage.json", circuit);

// console.log(`Lit Action CID: ${ipfsCid}`);
// console.log(`Compiled Circuit CID: ${circuitIpfsCid}`);
// console.log(`Verifier: ${verifierContractAddress}`);
// console.log(`ZKGate: ${zkGateAddress}`);
