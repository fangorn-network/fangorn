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
} from "viem";
import { privateKeyToAccount, PrivateKeyAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { createLitClient } from "@lit-protocol/lit-client";
import { nagaDev } from "@lit-protocol/networks";
import { readFileSync, writeFileSync } from "fs";
import { basename, extname } from "path";
import { Fangorn, FangornConfig, AppConfig } from "./fangorn.js";
import { Filedata } from "./types/types.js";
import "dotenv/config";

interface Config {
	rpcUrl: string;
	jwt: string;
	gateway: string;
	privateKey: Hex;
	litActionCid?: string;
	contentRegistryAddress?: Address;
	usdcContractAddress?: Address;
}

let _config: Config | null = null;
let _account: PrivateKeyAccount | null = null;
let _fangorn: Fangorn | null = null;

function loadConfig(): Config {
	if (_config) return _config;

	const rpcUrl = process.env.CHAIN_RPC_URL;
	const jwt = process.env.PINATA_JWT;
	const gateway = process.env.PINATA_GATEWAY;
	const privateKey = process.env.DELEGATOR_ETH_PRIVATE_KEY as Hex;

	if (!rpcUrl || !jwt || !gateway || !privateKey) {
		throw new Error(
			"Missing required env vars: CHAIN_RPC_URL, PINATA_JWT, PINATA_GATEWAY, DELEGATOR_ETH_PRIVATE_KEY",
		);
	}

	_config = {
		rpcUrl,
		jwt,
		gateway,
		privateKey,
		litActionCid: process.env.LIT_ACTION_CID,
		contentRegistryAddress: process.env.CONTENT_REGISTRY_ADDR as Address,
		usdcContractAddress: process.env.USDC_CONTRACT_ADDRESS as Address,
	};
	return _config;
}

function getAccount(): PrivateKeyAccount {
	if (_account) return _account;
	_account = privateKeyToAccount(loadConfig().privateKey);
	return _account;
}

function deriveVaultId(name: string): Hex {
	return keccak256(
		encodeAbiParameters(parseAbiParameters("string, address"), [
			name,
			getAccount().address,
		]),
	);
}

async function getFangorn(): Promise<Fangorn> {
	if (_fangorn) return _fangorn;

	const cfg = loadConfig();
	const walletClient = createWalletClient({
		account: getAccount(),
		transport: http(cfg.rpcUrl),
		chain: baseSepolia,
	});

	const litClient = await createLitClient({ network: nagaDev });

	const appConfig: AppConfig = {
		...FangornConfig.Testnet,
		rpcUrl: cfg.rpcUrl,
		...(cfg.litActionCid && { litActionCid: cfg.litActionCid }),
		...(cfg.contentRegistryAddress && {
			contentRegistryContractAddress: cfg.contentRegistryAddress,
		}),
		...(cfg.usdcContractAddress && {
			usdcContractAddress: cfg.usdcContractAddress,
		}),
	};

	const domain = process.env.DOMAIN || "localhost:3000";
	_fangorn = await Fangorn.init(
		cfg.jwt,
		cfg.gateway,
		walletClient,
		litClient,
		domain,
		appConfig,
	);
	return _fangorn;
}

// CLI setup
const program = new Command();

program
	.name("fangorn")
	.description("CLI for Fangorn - token-gated content management")
	.version("0.1.0");

program
	.command("create-vault")
	.description("Create a new vault")
	.argument("<name>", "Name of the vault")
	.action(async (name: string) => {
		try {
			const fangorn = await getFangorn();
			const vaultId = await fangorn.createVault(name);
			console.log(`Vault created: ${vaultId}`);
			process.exit(0);
		} catch (err) {
			console.error("Failed to create vault:", (err as Error).message);
			process.exit(1);
		}
	});

program
	.command("upload")
	.description("Upload file(s) to a vault")
	.argument("<name>", "Vault name")
	.argument("<files...>", "File path(s) to upload")
	.option("-p, --price <price>", "Price per file (default: 0)", "0")
	.option("--overwrite", "Overwrite existing vault contents")
	.action(async (name: string, files: string[], options) => {
		try {
			const vaultId = deriveVaultId(name);
			const fangorn = await getFangorn();

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

			const result = await fangorn.upload(vaultId, filedata, options.overwrite);
			console.log(`Upload complete! Manifest CID: ${result.manifestCid}`);
			process.exit(0);
		} catch (err) {
			console.error("Failed to upload:", (err as Error).message);
			process.exit(1);
		}
	});

program
	.command("list")
	.description("List contents of a vault")
	.argument("<name>", "Vault name")
	.action(async (name: string) => {
		try {
			const vaultId = deriveVaultId(name);
			const fangorn = await getFangorn();
			const manifest = await fangorn.getManifest(vaultId);

			console.log(`Vault: ${name} (${vaultId})`);
			console.log(`Entries (${manifest.entries.length}):`);
			for (const entry of manifest.entries) {
				console.log(
					`  - ${entry.tag} | price: ${entry.price} | cid: ${entry.cid}`,
				);
			}
			process.exit(0);
		} catch (err) {
			console.error("Failed to list vault:", (err as Error).message);
			process.exit(1);
		}
	});

program
	.command("info")
	.description("Get vault info from contract")
	.argument("<name>", "Vault name")
	.action(async (name: string) => {
		try {
			const vaultId = deriveVaultId(name);
			const fangorn = await getFangorn();
			const vault = await fangorn.getVault(vaultId);

			console.log(`Vault: ${name} (${vaultId})`);
			console.log(`Owner: ${vault.owner}`);
			console.log(`Manifest CID: ${vault.manifestCid}`);
			process.exit(0);
		} catch (err) {
			console.error("Failed to get vault info:", (err as Error).message);
			process.exit(1);
		}
	});

program
	.command("decrypt")
	.description("Decrypt a file from a vault")
	.argument("<name>", "Vault name")
	.argument("<tag>", "File tag")
	.option("-o, --output <path>", "Output file path")
	.action(async (name: string, tag: string, options) => {
		try {
			const vaultId = deriveVaultId(name);
			const fangorn = await getFangorn();
			const decrypted = await fangorn.decryptFile(vaultId, tag);

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

program
	.command("entry")
	.description("Get info about a specific vault entry")
	.argument("<name>", "Vault name")
	.argument("<tag>", "File tag")
	.action(async (name: string, tag: string) => {
		try {
			const vaultId = deriveVaultId(name);
			const fangorn = await getFangorn();
			const entry = await fangorn.getVaultData(vaultId, tag);

			console.log(`Entry: ${tag}`);
			console.log(`  CID: ${entry.cid}`);
			console.log(`  Price: ${entry.price}`);
			process.exit(0);
		} catch (err) {
			console.error("Failed to get entry:", (err as Error).message);
			process.exit(1);
		}
	});

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
