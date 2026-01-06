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
import { Barretenberg, UltraHonkBackend } from "@aztec/bb.js";
import { baseSepolia } from "viem/chains";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// const circuit = require("../circuits/sum3-circuit/target/circuit.json");
const circuit = require("../circuits/preimage/target/preimage.json");

const currentChain = baseSepolia;

/**
 * Compiles verifier from circuit
 */
async function compileVerifier(): Promise<
	Record<string, { abi: any; bytecode: string }>
> {
	const api = await Barretenberg.new({ threads: 1 });
	const backend = new UltraHonkBackend(circuit.bytecode, api);
	const vk = await backend.getVerificationKey({ verifierTarget: "evm" });
	const verifierSource = await backend.getSolidityVerifier(vk, {
		verifierTarget: "evm",
	});

	const input = {
		language: "Solidity",
		sources: {
			"PreimageVerifier.sol": { content: verifierSource },
		},
		settings: {
			metadata: {
				appendCBOR: false,
				useLiteralContent: false,
			},
			optimizer: { enabled: true, runs: 1 },
			outputSelection: {
				"*": { "*": ["abi", "evm.bytecode"] },
			},
		},
	};

	const output = JSON.parse(solc.compile(JSON.stringify(input)));

	if (output.errors?.some((e: any) => e.severity === "error")) {
		console.error(
			"Compilation errors:",
			output.errors.filter((e: any) => e.severity === "error"),
		);
		throw new Error("Verifier compilation failed");
	}

	const contracts: Record<string, { abi: any; bytecode: string }> = {};
	for (const [name, contract] of Object.entries(
		output.contracts["PreimageVerifier.sol"],
	)) {
		contracts[name] = {
			abi: (contract as any).abi,
			bytecode: (contract as any).evm.bytecode.object,
		};
	}

	return contracts;
}
/**
 * Compiles ZKGate
 */
function compileZKGate(): { abi: any; bytecode: string } {
	const zkGatePath = join(__dirname, "..", "./contracts", "ZKGate.sol");
	const zkGateSource = readFileSync(zkGatePath, "utf-8");

	const input = {
		language: "Solidity",
		sources: {
			"ZKGate.sol": { content: zkGateSource },
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

	if (output.errors?.some((e: any) => e.severity === "error")) {
		console.error(
			"Compilation errors:",
			output.errors.filter((e: any) => e.severity === "error"),
		);
		throw new Error("ZKGate compilation failed");
	}

	const zkGate = output.contracts["ZKGate.sol"]["ZKGate"];
	return {
		abi: zkGate.abi,
		bytecode: zkGate.evm.bytecode.object,
	};
}

/**
 * Links library addresses into bytecode
 */
function linkBytecode(
	bytecode: string,
	libraries: Record<string, Address>,
): Hex {
	let linked = bytecode;
	for (const [, libAddress] of Object.entries(libraries)) {
		// This replaces ALL placeholders with the same address - is that correct?
		// If you have multiple libraries, each needs its own address
		linked = linked.replace(
			/__\$[a-fA-F0-9]{34}\$__/g,
			libAddress.slice(2).toLowerCase(),
		);
	}

	const remaining = linked.match(/__\$[a-fA-F0-9]{34}\$__/);
	if (remaining) {
		throw new Error(`Unlinked library: ${remaining[0]}`);
	}

	return `0x${linked}` as Hex;
}

/**
 * Deploys HonkVerifier (circuit-specific)
 */
export async function deployVerifier({
	account,
}: {
	account: Account;
}): Promise<{
	verifierAddress: Address;
	verifierAbi: any;
}> {
	console.log("Compiling verifier...");
	const contracts = await compileVerifier();

	const rpcUrl = process.env.CHAIN_RPC_URL;
	if (!rpcUrl)
		throw new Error("CHAIN_RPC_URL environment variable is required");

	const publicClient = createPublicClient({ transport: http(rpcUrl) });
	const walletClient = createWalletClient({ account, transport: http(rpcUrl) });

	// 1. Deploy ZKTranscriptLib
	console.log("Deploying ZKTranscriptLib...");
	const libBytecode = contracts["ZKTranscriptLib"]?.bytecode;
	if (!libBytecode) throw new Error("ZKTranscriptLib not found");

	console.log("Estimating gas...");
	const gasEstimate = await publicClient.estimateGas({
		data: `0x${libBytecode}` as Hex,
		account: walletClient.account.address,
	});
	console.log("Gas estimate:", gasEstimate);
	const gasPrice = await publicClient.getGasPrice();
	let nonce = await publicClient.getTransactionCount({
		address: walletClient.account.address,
	});

	console.log("Sending transaction...");
	const libHash = await walletClient.sendTransaction({
		data: `0x${libBytecode}` as Hex,
		gas: gasEstimate + gasEstimate / 10n,
		gasPrice: gasPrice,
		// nonce: nonce + 1,
		chain: currentChain,
	});
	// gas estimation was failing when using `deployContract` against lineaSepolia, no idea why
	const libReceipt = await publicClient.waitForTransactionReceipt({
		hash: libHash,
	});
	const libAddress = libReceipt.contractAddress!;
	console.log(`ZKTranscriptLib deployed: ${libAddress}`);

	// 2. Deploy HonkVerifier with linked library
	console.log("Deploying HonkVerifier...");
	const verifier = contracts["HonkVerifier"];
	if (!verifier) throw new Error("HonkVerifier not found");

	const linkedBytecode = linkBytecode(verifier.bytecode, {
		ZKTranscriptLib: libAddress,
	});

	// Estimate gas for the VERIFIER, not the library
	const verifierGasEstimate = await publicClient.estimateGas({
		data: linkedBytecode,
		account: walletClient.account.address,
	});
	console.log("Verifier gas estimate:", verifierGasEstimate);

	nonce = await publicClient.getTransactionCount({
		address: walletClient.account.address,
	});
	console.log("Sending transaction...");
	const verifierHash = await walletClient.sendTransaction({
		data: linkedBytecode,
		gas: verifierGasEstimate + verifierGasEstimate / 10n,
		gasPrice: gasPrice,
		// nonce: nonce + 1,
		chain: currentChain,
	});

	const verifierReceipt = await publicClient.waitForTransactionReceipt({
		hash: verifierHash,
	});
	console.log("Receipt status:", verifierReceipt.status); // should be 'success'
	console.log(
		"Contract address from receipt:",
		verifierReceipt.contractAddress,
	);

	// Verify it has code
	const code = await publicClient.getCode({
		address: verifierReceipt.contractAddress!,
	});
	console.log("Code length:", code?.length);
	console.log("Has code:", code && code !== "0x" && code.length > 2);

	// Then use this address
	// const verifierAddress = verifierReceipt.contractAddress!;

	// const verifierReceipt = await publicClient.waitForTransactionReceipt({ hash: verifierHash });
	const verifierAddress = verifierReceipt.contractAddress!;
	console.log(`HonkVerifier deployed: ${verifierAddress}`);

	return {
		verifierAddress,
		verifierAbi: verifier.abi,
	};
}

/**
 * Deploys ZKGate (universal, verifier-agnostic)
 */
export async function deployZKGate({
	account,
	verifierAddress,
	treasuryAddress,
	vaultCreationFee,
}: {
	account: Account;
	verifierAddress: Address;
	treasuryAddress: Address;
	vaultCreationFee: bigint;
}): Promise<{
	zkGateAddress: Address;
	zkGateAbi: any;
}> {
	console.log("Compiling ZKGate...");
	const zkGate = compileZKGate();

	const rpcUrl = process.env.CHAIN_RPC_URL;
	if (!rpcUrl)
		throw new Error("CHAIN_RPC_URL environment variable is required");

	const publicClient = createPublicClient({ transport: http(rpcUrl) });
	const walletClient = createWalletClient({ account, transport: http(rpcUrl) });

	console.log("Deploying ZKGate...");

	// Encode bytecode + constructor args
	const deployData = encodeDeployData({
		abi: zkGate.abi,
		bytecode: `0x${zkGate.bytecode}` as Hex,
		args: [verifierAddress, treasuryAddress, vaultCreationFee],
	});

	const gasPrice = await publicClient.getGasPrice();
	const gasEstimate = await publicClient.estimateGas({
		data: deployData,
		account: walletClient.account.address,
	});

	const zkGateHash = await walletClient.sendTransaction({
		data: deployData,
		gas: gasEstimate + gasEstimate / 10n,
		gasPrice: gasPrice,
		chain: currentChain,
	});

	const zkGateReceipt = await publicClient.waitForTransactionReceipt({
		hash: zkGateHash,
	});

	const zkGateAddress = zkGateReceipt.contractAddress!;
	console.log(`ZKGate deployed: ${zkGateAddress}`);

	return {
		zkGateAddress,
		zkGateAbi: zkGate.abi,
	};
}

/**
 * Deploys both contracts
 */
export async function deployContracts({
	account,
}: {
	account: Account;
}): Promise<{
	verifierAddress: Address;
	zkGateAddress: Address;
	verifierAbi: any;
	zkGateAbi: any;
}> {
	const { verifierAddress, verifierAbi } = await deployVerifier({ account });
	const { zkGateAddress, zkGateAbi } = await deployZKGate({
		account,
		verifierAddress: verifierAddress,
		// or a dedicated treasury
		treasuryAddress: account.address,
		// $1 equivalent or w/e
		vaultCreationFee: parseEther("0.001"),
	});

	return {
		verifierAddress,
		zkGateAddress,
		verifierAbi,
		zkGateAbi,
	};
}

/**
 * Verifies a proof using a deployed verifier contract
 */
export async function verifyProof({
	contractAddress,
	abi,
	proof,
	publicInputs,
}: {
	contractAddress: Address;
	abi: any;
	proof: Hex;
	publicInputs: Hex[];
}): Promise<boolean> {
	const rpcUrl = process.env.CHAIN_RPC_URL;
	if (!rpcUrl)
		throw new Error("CHAIN_RPC_URL environment variable is required");

	const publicClient = createPublicClient({ transport: http(rpcUrl) });

	const result = await publicClient.readContract({
		address: contractAddress,
		abi,
		functionName: "verify",
		args: [proof, publicInputs],
	});

	console.log(`Verification result: ${result}`);
	return result as boolean;
}
