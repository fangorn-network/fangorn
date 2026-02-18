#!/usr/bin/env node
import { Command } from "commander";
import {
	createWalletClient,
	Hex,
	http,
	Address,
	keccak256,
	encodeAbiParameters,
	parseAbiParameters,
	Chain,
} from "viem";
import { privateKeyToAccount, PrivateKeyAccount } from "viem/accounts";
import { createLitClient } from "@lit-protocol/lit-client";
import { nagaDev } from "@lit-protocol/networks";
import { readFileSync, writeFileSync } from "fs";
import { basename, extname } from "path";
import { Fangorn } from "./fangorn.js";
import { Filedata } from "./types/index.js";
import "dotenv/config";
import { PinataSDK } from "pinata";
import { PinataStorage } from "./providers/storage/index.js";
import getNetwork, {
	AppConfig,
	FangornConfig,
	SupportedNetworks,
} from "./config.js";
import { LitEncryptionService } from "./modules/encryption/lit.js";
import { computeTagCommitment, fieldToHex } from "./utils/index.js";
import { PaymentPredicate } from "./modules/predicates/payment.js";

interface Config {
	jwt: string;
	gateway: string;
	privateKey: Hex;
	cfg: AppConfig;
}

let _config: Config | null = null;
let _account: PrivateKeyAccount | null = null;
let _fangorn: Fangorn | null = null;

function loadConfig(): Config {
	if (_config) return _config;

	// const rpcUrl = process.env.CHAIN_RPC_URL;
	const jwt = process.env.PINATA_JWT;
	const gateway = process.env.PINATA_GATEWAY;
	const privateKey = process.env.DELEGATOR_ETH_PRIVATE_KEY as Hex;
	const chainName = process.env.CHAIN_NAME;

	if (!chainName || !jwt || !gateway || !privateKey) {
		throw new Error(
			"Missing required env vars: CHAIN_NAME, PINATA_JWT, PINATA_GATEWAY, DELEGATOR_ETH_PRIVATE_KEY",
		);
	}

	let config = FangornConfig.BaseSepolia;
	if (chainName === SupportedNetworks.ArbitrumSepolia.name) {
		console.log("using arbitrum sepolia");
		config = FangornConfig.ArbitrumSepolia;
	}

	_config = {
		jwt,
		gateway,
		privateKey,
		cfg: config,
	};
	return _config;
}

function getAccount(): PrivateKeyAccount {
	if (_account) return _account;
	_account = privateKeyToAccount(loadConfig().privateKey);
	return _account;
}

// function deriveVaultId(name: string): Hex {
// 	return keccak256(
// 		encodeAbiParameters(parseAbiParameters("string, address"), [
// 			name,
// 			getAccount().address,
// 		]),
// 	);
// }

async function getFangorn(chain: Chain): Promise<Fangorn> {
	if (_fangorn) return _fangorn;

	const cfg = loadConfig();
	const walletClient = createWalletClient({
		account: getAccount(),
		transport: http(cfg.cfg.rpcUrl),
		chain,
	});

	const litClient = await createLitClient({ network: nagaDev });

	// default to arbitrum sepolia
	const appConfig: AppConfig = cfg.cfg;

	const domain = process.env.DOMAIN || "localhost:3000";

	// storage via Pinata
	const pinata = new PinataSDK({
		pinataJwt: cfg.jwt,
		pinataGateway: cfg.gateway,
	});
	const storage = new PinataStorage(pinata);
	const chainName = process.env.CHAIN_NAME;
	const encryptionService = new LitEncryptionService(litClient, {
		chainName,
	});

	_fangorn = await Fangorn.init(
		walletClient,
		storage,
		encryptionService,
		domain,
		appConfig,
	);

	return _fangorn;
}

const getChain = (chainStr: string) => {
	console.log("getting chain for string " + chainStr);
	return getNetwork(chainStr);
};

// CLI setup
const program = new Command();
program.name("Fangorn").description("CLI for Fangorn").version("9129129");

program
	.command("register")
	.description("Register a new data source")
	.argument("<name>", "Name of the data source")
	.option(
		"-c, --chain <chain>",
		"The chain to use as the backend (arbitrumSepolia or baseSepolia)",
	)
	.action(async (name: string, options) => {
		try {
			const chain = getChain(options.chain);
			const fangorn = await getFangorn(chain);
			const vaultId = await fangorn.registerDataSource(name);
			console.log(`Data source registered with id = ${vaultId}`);
			process.exit(0);
		} catch (err) {
			console.error("Failed to register data source:", (err as Error).message);
			process.exit(1);
		}
	});

program
	.command("upload")
	.description("Upload file(s) to a data source")
	.argument("<name>", "Data source name")
	.argument("<files...>", "File path(s) to upload")
	.option(
		"-c, --chain <chain>",
		"The chain to use as the backend (arbitrumSepolia or baseSepolia)",
	)
	.option("-p, --price <price>", "Price to access the file (default: 0)", "0")
	.option("--overwrite", "Overwrite existing data source contents")
	.action(async (name: string, files: string[], options) => {
		try {
			// const vaultId = deriveVaultId(name);
			const owner = getAccount().address;
			const chain = getChain(options.chain);
			const fangorn = await getFangorn(chain);

			const filedata: Filedata[] = files.map((filepath) => {
				const data = readFileSync(filepath);
				const tag = basename(filepath);
				const extension = extname(filepath);
				return {
					tag,
					data: data.toString("base64"),
					price: options.price,
					extension,
					fileType: getMimeType(extension),
				};
			});

			const cid = await fangorn.upload(
				name,
				filedata,
				async (file) => {
					const commitment = await computeTagCommitment(
						owner,
						name,
						file.tag,
						options.price,
					);

					console.log("using commitment " + fieldToHex(commitment));
					return new PaymentPredicate({
						commitment: fieldToHex(commitment),
						chainName: "arbitrumSepolia",
						settlementTrackerContractAddress:
							"0xb32ed201896ba765e6aa118a5c18c263f559474e" as Address,
						usdcPrice: options.price,
					});
				},
				options.overwrite,
			);
			console.log(`Upload complete! Manifest CID: ${cid}`);
			process.exit(0);
		} catch (err) {
			console.error("Failed to upload:", (err as Error).message);
			process.exit(1);
		}
	});

// program
// 	.command("list")
// 	.description("List contents (index) of a data source")
// 	.argument("<name>", "Data source name")
// 	.option(
// 		"-c, --chain <chain>",
// 		"The chain to use as the backend (arbitrumSepolia or baseSepolia)",
// 	)
// 	.action(async (name: string, options) => {
// 		try {
// 			const vaultId = deriveVaultId(name);
// 			const chain = getChain(options.chain);
// 			const fangorn = await getFangorn(chain);
// 			const manifest = await fangorn.getManifest(vaultId);

// 			if (!manifest) {
// 				console.log("The data source is empty. \n");
// 				console.log(
// 					"Upload data with `fangorn upload <dataSourceName> <file> --price <set-price>",
// 				);
// 				process.exit(0);
// 			}
// 			console.log(`Vault: ${name} (${vaultId})`);
// 			console.log(`Entries (${manifest.entries.length}):`);
// 			for (const entry of manifest.entries) {
// 				console.log(
// 					`  - ${entry.tag} | price: ${entry.price} | cid: ${entry.cid}`,
// 				);
// 			}
// 			process.exit(0);
// 		} catch (err) {
// 			console.error("Failed to list vault:", (err as Error).message);
// 			process.exit(1);
// 		}
// 	});

// program
// 	.command("info")
// 	.description("Get data source info from contract")
// 	.argument("<name>", "Data source name")
// 	.option(
// 		"-c, --chain <chain>",
// 		"The chain to use as the backend (arbitrumSepolia or baseSepolia)",
// 	)
// 	.action(async (name: string, options) => {
// 		try {
// 			const vaultId = deriveVaultId(name);
// 			const chain = getChain(options.chain);
// 			const fangorn = await getFangorn(chain);
// 			const vault = await fangorn.getDataSource(vaultId);

// 			console.log(`Vault: ${name} (${vaultId})`);
// 			console.log(`Owner: ${vault.owner}`);
// 			console.log(
// 				`Manifest CID: ${vault.manifestCid == "" ? "Upload data with `fangorn upload <vaultName> <file> --price <set-price>`" : vault.manifestCid}`,
// 			);
// 			process.exit(0);
// 		} catch (err) {
// 			console.error("Failed to get vault info:", (err as Error).message);
// 			process.exit(1);
// 		}
// 	});

program
	.command("decrypt")
	.description("Decrypt a file from a vault")
	.argument("<owner>", "The owner of the datasource")
	.argument("<name>", "The name of the datasource")
	.argument("<tag>", "File tag")
	.option(
		"-c, --chain <chain>",
		"The chain to use as the backend (arbitrumSepolia or baseSepolia",
	)
	.option("-o, --output <path>", "Output file path")
	.action(async (owner: Address, name: string, tag: string, options) => {
		try {
			const chain = getChain(options.chain);
			const fangorn = await getFangorn(chain);
			const decrypted = await fangorn.decryptFile(owner, name, tag);

			if (options.output) {
				writeFileSync(options.output, Buffer.from(decrypted));
				console.log(`Decrypted file saved to: ${options.output}`);
			} else {
				process.stdout.write(Buffer.from(decrypted));
			}
			process.exit(0);
		} catch (err) {
			console.error("Failed to decrypt:", (err as Error).message);
			process.exit(1);
		}
	});

// program
// 	.command("entry")
// 	.description("Get info about a specific vault entry")
// 	.argument("<name>", "Vault name")
// 	.argument("<tag>", "File tag")
// 	.option(
// 		"-c, --chain <chain>",
// 		"The chain to use as the backend (arbitrumSepolia or baseSepolia",
// 	)
// 	.action(async (name: string, tag: string, options) => {
// 		try {
// 			const vaultId = deriveVaultId(name);
// 			const chain = getChain(options.chain);
// 			const fangorn = await getFangorn(chain);
// 			const entry = await fangorn.getDataSourceData(vaultId, tag);

// 			console.log(`Entry: ${tag}`);
// 			console.log(`  CID: ${entry.cid}`);
// 			console.log(`  Price: ${entry.price}`);
// 			process.exit(0);
// 		} catch (err) {
// 			console.error("Failed to get entry:", (err as Error).message);
// 			process.exit(1);
// 		}
// 	});

function getMimeType(ext: string): string {
	const types: Record<string, string> = {
		".txt": "text/plain",
		".json": "application/json",
		".html": "text/html",
		".css": "text/css",
		".js": "application/javascript",
		".png": "image/png",
		".jpg": "image/jpeg",
		".jpeg": "image/jpeg",
		".gif": "image/gif",
		".pdf": "application/pdf",
		".mp3": "audio/mpeg",
		".mp4": "video/mp4",
	};
	return types[ext.toLowerCase()] || "application/octet-stream";
}

program.parse();
