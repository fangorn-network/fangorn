import { ethers } from "ethers";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
	createWalletClient,
	createPublicClient,
	http,
	type Account,
	type Address,
	type Hex,
	encodeDeployData,
	parseEther,
} from "viem";
import solc from "solc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function compileContract(contractName: string): { abi: any; bytecode: string } {
	const fileName = `${contractName}.sol`;
	const path = join(__dirname, "..", "contracts", "src", fileName);
	const source = readFileSync(path, "utf-8");

	const input = {
		language: "Solidity",
		sources: {
			[fileName]: { content: source },
		},
		settings: {
			metadata: {
				appendCBOR: false,
				useLiteralContent: false,
			},
			optimizer: { enabled: true, runs: 200 },
			outputSelection: {
				"*": { "*": ["abi", "evm.bytecode"] },
			},
		},
	};

	const output = JSON.parse(solc.compile(JSON.stringify(input)));

	// Filter for actual errors (ignore warnings)
	const errors = output.errors?.filter((e: any) => e.severity === "error");
	if (errors && errors.length > 0) {
		console.error(`Compilation errors in ${fileName}:`, errors);
		throw new Error(`${contractName} compilation failed`);
	}

	const contractData = output.contracts[fileName][contractName];

	return {
		abi: contractData.abi,
		bytecode: contractData.evm.bytecode.object,
	};
}

/**
 * Deploys any contract by name from the local contracts directory.
 */
export async function deployContract({
	account,
	contractName,
	constructorArgs = [],
	chain,
}: {
	account: Account;
	contractName: string;
	constructorArgs?: any[];
	chain: any;
}): Promise<{ address: Address; abi: any }> {
	console.log(`Compiling ${contractName}...`);
	const compiled = compileContract(contractName);

	const rpcUrl = process.env.CHAIN_RPC_URL;
	if (!rpcUrl) throw new Error("CHAIN_RPC_URL environment variable required");

	const publicClient = createPublicClient({ transport: http(rpcUrl) });
	const walletClient = createWalletClient({ account, transport: http(rpcUrl) });

	console.log(`Deploying ${contractName}...`);

	// Encode constructor args dynamically
	const deployData = encodeDeployData({
		abi: compiled.abi,
		bytecode: `0x${compiled.bytecode}` as Hex,
		args: constructorArgs,
	});

	// Estimate gas
	const gasPrice = await publicClient.getGasPrice();
	console.log("the gas price is " + gasPrice);
	const gasEstimate = await publicClient.estimateGas({
		data: deployData,
		account: walletClient.account.address,
	});

	// Send transaction
	const txHash = await walletClient.sendTransaction({
		data: deployData,
		gas: gasEstimate + gasEstimate / 10n, // 10% buffer
		// gasPrice,
		chain,
	} as any);

	// Wait for deployment
	const receipt = await publicClient.waitForTransactionReceipt({
		hash: txHash,
	});
	const address = receipt.contractAddress!;

	console.log(`${contractName} deployed at: ${address}`);

	return { address, abi: compiled.abi };
}
