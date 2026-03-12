import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
	createWalletClient,
	createPublicClient,
	http,
	type Account,
	type Address,
	encodeDeployData,
	Chain,
	Abi,
} from "viem";
import solc from "solc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function compileContract(contractName: string): { abi: Abi; bytecode: string } {
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

	// Cast the compile call
	const output = JSON.parse((solc as { compile: (input: string) => string }).compile(JSON.stringify(input))) as {
	    errors?: { severity: string }[];
	    contracts: Record<string, Record<string, {
	        abi: unknown[];
	        evm: { bytecode: { object: string } };
	    }>>;
	};

	// Filter for actual errors (ignore warnings)
	const errors = output.errors?.filter((e) => e.severity === "error");
	if (errors && errors.length > 0) {
		console.error(`Compilation errors in ${fileName}:`, errors);
		throw new Error(`${contractName} compilation failed`);
	}

	const contractData = output.contracts[fileName][contractName];
	const abi = contractData.abi as Abi;

	return {
		abi,
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
	constructorArgs?: unknown[];
	chain: Chain;
}): Promise<{ address: Address; abi: Abi }> {
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
		bytecode: `0x${compiled.bytecode}`,
		args: constructorArgs,
	});

	// Estimate gas
	const gasPrice = await publicClient.getGasPrice();
	console.log(`the gas price is ${String(gasPrice)}`);
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
	} as Parameters<typeof walletClient.sendTransaction>[0]);

	// Wait for deployment
	const receipt = await publicClient.waitForTransactionReceipt({
		hash: txHash,
	});

	if (!receipt.contractAddress) {
		throw new Error(`${contractName} deployment failed: no contract address in receipt`);
	}

	console.log(`${contractName} deployed at: ${receipt.contractAddress}`);

	const abi = compiled.abi;

	return { address: receipt.contractAddress, abi };
}
