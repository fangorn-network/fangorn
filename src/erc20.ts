import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
	createWalletClient,
	createPublicClient,
	http,
	parseEther,
	type Account,
	type Address,
} from "viem";
import solc from "solc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Compiles the TestToken contract
 */
function compileContract(): { abi: any; bytecode: string } {
	const contractPath = join(__dirname, "..", "contracts", "TestToken.sol");
	const source = readFileSync(contractPath, "utf-8");

	// Import OpenZeppelin contracts
	const ozERC20Path =
		require.resolve("@openzeppelin/contracts/token/ERC20/ERC20.sol");
	const ozOwnablePath =
		require.resolve("@openzeppelin/contracts/access/Ownable.sol");
	const ozContextPath =
		require.resolve("@openzeppelin/contracts/utils/Context.sol");
	const ozIERC20Path =
		require.resolve("@openzeppelin/contracts/token/ERC20/IERC20.sol");
	const ozIERC20MetadataPath =
		require.resolve("@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol");
	const ozIERC6093Path =
		require.resolve("@openzeppelin/contracts/interfaces/draft-IERC6093.sol");

	const input = {
		language: "Solidity",
		sources: {
			"TestToken.sol": {
				content: source,
			},
			"@openzeppelin/contracts/token/ERC20/ERC20.sol": {
				content: readFileSync(ozERC20Path, "utf-8"),
			},
			"@openzeppelin/contracts/access/Ownable.sol": {
				content: readFileSync(ozOwnablePath, "utf-8"),
			},
			"@openzeppelin/contracts/utils/Context.sol": {
				content: readFileSync(ozContextPath, "utf-8"),
			},
			"@openzeppelin/contracts/token/ERC20/IERC20.sol": {
				content: readFileSync(ozIERC20Path, "utf-8"),
			},
			"@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol": {
				content: readFileSync(ozIERC20MetadataPath, "utf-8"),
			},
			"@openzeppelin/contracts/interfaces/draft-IERC6093.sol": {
				content: readFileSync(ozIERC6093Path, "utf-8"),
			},
		},
		settings: {
			optimizer: {
				enabled: true,
				runs: 200,
			},
			outputSelection: {
				"*": {
					"*": ["abi", "evm.bytecode"],
				},
			},
		},
	};

	const output = JSON.parse(solc.compile(JSON.stringify(input)));

	if (output.errors) {
		const errors = output.errors.filter((e: any) => e.severity === "error");
		const warnings = output.errors.filter((e: any) => e.severity === "warning");

		if (warnings.length > 0) {
			console.warn(
				"Compilation warnings:",
				warnings.map((w: any) => w.message),
			);
		}

		if (errors.length > 0) {
			console.error("Compilation errors:", errors);
			throw new Error("Contract compilation failed");
		}
	}

	const contract = output.contracts["TestToken.sol"]["TestToken"];
	return {
		abi: contract.abi,
		bytecode: contract.evm.bytecode.object,
	};
}

/**
 * Deploys the TestToken contract
 */
export async function deployTestToken({
	account,
	name = "Test Token",
	symbol = "TEST",
	decimals = 18,
}: {
	account: Account;
	name?: string;
	symbol?: string;
	decimals?: number;
}): Promise<{
	address: Address;
	abi: any;
}> {
	console.log("Compiling TestToken contract...");
	const { abi, bytecode } = compileContract();

	const rpcUrl = process.env.ERC20_CHAIN_RPC_URL;
	if (!rpcUrl) {
		throw new Error("ERC20_CHAIN_RPC_URL environment variable is required");
	}

	const publicClient = createPublicClient({
		transport: http(rpcUrl),
	});

	const walletClient = createWalletClient({
		account,
		transport: http(rpcUrl),
	});

	console.log(`Deploying TestToken from ${account.address}...`);

	// Deploy contract
	const hash = await walletClient.deployContract({
		abi,
		bytecode: `0x${bytecode}`,
		args: [name, symbol, decimals],
		chain: undefined,
	});

	console.log(`Deployment tx: ${hash}`);
	console.log("Waiting for transaction receipt...");

	const receipt = await publicClient.waitForTransactionReceipt({ hash });

	if (!receipt.contractAddress) {
		throw new Error("Contract deployment failed - no contract address");
	}

	console.log(`TestToken deployed to: ${receipt.contractAddress}`);
	console.log(`Deployment status: ${receipt.status}`);

	// Wait a bit for the contract to be available
	await new Promise((resolve) => setTimeout(resolve, 2000));

	return {
		address: receipt.contractAddress,
		abi,
	};
}

/**
 * Mints tokens to an address
 */
export async function mintTokens({
	account,
	contractAddress,
	abi,
	to,
	amount,
}: {
	account: Account;
	contractAddress: Address;
	abi: any;
	to: Address;
	amount: string;
}): Promise<void> {
	const rpcUrl = process.env.ERC20_CHAIN_RPC_URL;
	if (!rpcUrl) {
		throw new Error("ERC20_CHAIN_RPC_URL environment variable is required");
	}

	const publicClient = createPublicClient({
		transport: http(rpcUrl),
	});

	const walletClient = createWalletClient({
		account,
		transport: http(rpcUrl),
	});

	console.log(`Minting ${amount} tokens to ${to}...`);

	const hash = await walletClient.writeContract({
		address: contractAddress,
		abi,
		functionName: "mint",
		args: [to, parseEther(amount)],
		chain: undefined,
	});

	console.log(`Mint tx: ${hash}`);
	const receipt = await publicClient.waitForTransactionReceipt({ hash });
	console.log(`Mint tx status: ${receipt.status}`);
	console.log(`Mint tx block number: ${receipt.blockNumber}`);

	// Wait for additional blocks to ensure state consistency across RPC nodes
	console.log("Waiting for additional block confirmations...");
	const currentBlock = receipt.blockNumber;
	const targetBlock = currentBlock + 2n; // Wait for 2 more blocks

	while (true) {
		const latestBlock = await publicClient.getBlockNumber();
		if (latestBlock >= targetBlock) {
			console.log(`Confirmed at block ${latestBlock}`);
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}

	console.log(`Minted ${amount} tokens successfully`);
}

/**
 * Gets the balance of an address
 */
export async function getBalance({
	contractAddress,
	abi,
	address,
}: {
	contractAddress: Address;
	abi: any;
	address: Address;
}): Promise<bigint> {
	const rpcUrl = process.env.ERC20_CHAIN_RPC_URL;
	if (!rpcUrl) {
		throw new Error("ERC20_CHAIN_RPC_URL environment variable is required");
	}

	const publicClient = createPublicClient({
		transport: http(rpcUrl),
	});

	const balance = await publicClient.readContract({
		address: contractAddress,
		abi,
		functionName: "balanceOf",
		args: [address],
	});

	return balance as bigint;
}
