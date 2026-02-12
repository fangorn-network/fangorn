import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createWalletClient, createPublicClient, http, encodeDeployData, } from "viem";
import solc from "solc";
import { baseSepolia } from "viem/chains";
// import circuit from "../circuits/preimage/target/preimage.json" with { type: "json" };
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const currentChain = baseSepolia;
function compileContract(contractName) {
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
    const errors = output.errors?.filter((e) => e.severity === "error");
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
 * Links library addresses into bytecode
 */
function linkBytecode(bytecode, libraries) {
    let linked = bytecode;
    for (const [, libAddress] of Object.entries(libraries)) {
        // This replaces ALL placeholders with the same address - is that correct?
        // If you have multiple libraries, each needs its own address
        linked = linked.replace(/__\$[a-fA-F0-9]{34}\$__/g, libAddress.slice(2).toLowerCase());
    }
    const remaining = linked.match(/__\$[a-fA-F0-9]{34}\$__/);
    if (remaining) {
        throw new Error(`Unlinked library: ${remaining[0]}`);
    }
    return `0x${linked}`;
}
/**
 * Deploys any contract by name from the local contracts directory.
 */
export async function deployContract({ account, contractName, constructorArgs = [], }) {
    console.log(`Compiling ${contractName}...`);
    const compiled = compileContract(contractName);
    const rpcUrl = process.env.CHAIN_RPC_URL;
    if (!rpcUrl)
        throw new Error("CHAIN_RPC_URL environment variable required");
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
    const gasEstimate = await publicClient.estimateGas({
        data: deployData,
        account: walletClient.account.address,
    });
    // Send transaction
    const txHash = await walletClient.sendTransaction({
        data: deployData,
        gas: gasEstimate + gasEstimate / 10n, // 10% buffer
        gasPrice,
        chain: currentChain,
    });
    // Wait for deployment
    const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
    });
    const address = receipt.contractAddress;
    console.log(`${contractName} deployed at: ${address}`);
    return { address, abi: compiled.abi };
}
