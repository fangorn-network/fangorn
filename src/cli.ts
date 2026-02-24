#!/usr/bin/env node
import { Command } from "commander";
import {
	intro,
	outro,
	text,
	confirm,
	select,
	note,
	spinner,
	isCancel,
	multiselect,
} from "@clack/prompts";
import { createWalletClient, Hex, http, Address, Chain } from "viem";
import { privateKeyToAccount, PrivateKeyAccount } from "viem/accounts";
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
import { PaymentGadget } from "./modules/gadgets/payment.js";
import {
	agentCardBuilder,
	AgentCardBuilder,
} from "./builders/a2aCardBuilder.js";
import { SDK } from "agent0-sdk";
import {
	chmodSync,
	exists,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "fs";
import { basename, extname, join } from "path";
import { homedir } from "os";

// the config for the cli + fangorn
interface Config {
	jwt: string;
	gateway: string;
	privateKey: Hex;
	cfg: AppConfig;
}

// the config interface for the user secrets
interface StoredConfig {
	privateKey: Hex;
	jwt: string;
	gateway: string;
	chainName: string;
}

const CONFIG_DIR = join(homedir(), ".fangorn");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

let _config: Config | null = null;
let _account: PrivateKeyAccount | null = null;
let _fangorn: Fangorn | null = null;

// function loadConfig(): Config {
// 	if (_config) return _config;

// 	const jwt = process.env.PINATA_JWT;
// 	const gateway = process.env.PINATA_GATEWAY;
// 	const privateKey = process.env.DELEGATOR_ETH_PRIVATE_KEY as Hex;
// 	const chainName = process.env.CHAIN_NAME;

// 	if (!chainName || !jwt || !gateway || !privateKey) {
// 		throw new Error(
// 			"Missing required env vars: CHAIN_NAME, PINATA_JWT, PINATA_GATEWAY, DELEGATOR_ETH_PRIVATE_KEY",
// 		);
// 	}

// 	let config = FangornConfig.BaseSepolia;
// 	if (chainName === SupportedNetworks.ArbitrumSepolia.name) {
// 		config = FangornConfig.ArbitrumSepolia;
// 	}

// 	_config = {
// 		jwt,
// 		gateway,
// 		privateKey,
// 		cfg: config,
// 	};
// 	return _config;
// }

function loadConfig(): Config {
	if (_config) return _config;

	// 1. try env vars
	const privateKey = process.env.DELEGATOR_ETH_PRIVATE_KEY as Hex;
	const jwt = process.env.PINATA_JWT;
	const gateway = process.env.PINATA_GATEWAY;
	const chainName = process.env.CHAIN_NAME;

	if (privateKey && jwt && gateway && chainName) {
		_config = buildConfig({ privateKey, jwt, gateway, chainName });
		return _config;
	}

	// 2. fall back to ~/.fangorn/config.json
	if (existsSync(CONFIG_PATH)) {
		const stored: StoredConfig = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		_config = buildConfig(stored);
		return _config;
	}

	// 3. nothing found
	throw new Error(
		"No configuration found. Run `fangorn init` to set up your credentials, " +
			"or set DELEGATOR_ETH_PRIVATE_KEY, PINATA_JWT, PINATA_GATEWAY, and CHAIN_NAME env vars.",
	);
}

function buildConfig({
	privateKey,
	jwt,
	gateway,
	chainName,
}: StoredConfig): Config {
	let cfg = FangornConfig.BaseSepolia;
	if (chainName === SupportedNetworks.ArbitrumSepolia.name) {
		cfg = FangornConfig.ArbitrumSepolia;
	}
	return { privateKey, jwt, gateway, cfg };
}

function getAccount(): PrivateKeyAccount {
	if (_account) return _account;
	_account = privateKeyToAccount(loadConfig().privateKey);
	return _account;
}

async function getFangorn(chain: Chain): Promise<Fangorn> {
	if (_fangorn) return _fangorn;

	const cfg = loadConfig();
	const walletClient = createWalletClient({
		account: getAccount(),
		transport: http(cfg.cfg.rpcUrl),
		chain,
	});

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
	const encryptionService = await LitEncryptionService.init(chainName);

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
	return getNetwork(chainStr);
};

const handleCancel = (value: unknown) => {
	if (isCancel(value)) {
		process.exit(0);
	}
};

const selectChain = async () => {
	const chainChoice = await select({
		message: "Pick your chain.",
		options: [
			{ value: "arbitrumSepolia", label: "Arbitrum Sepolia" },
			{ value: "baseSepolia", label: "Base Sepolia" },
		],
	});
	handleCancel(chainChoice);
	return getNetwork(chainChoice.toString());
};

// CLI setup
const program = new Command();
program.name("Fangorn").description("CLI for Fangorn").version("0.0.1");

program
	.command("init")
	.description("Configure your Fangorn credentials")
	.action(async () => {
		intro("Fangorn Setup");

		const privateKey = await text({
			message: "Your wallet private key (stored locally, never transmitted):",
			placeholder: "0x...",
			validate: (v) => {
				if (!v.startsWith("0x") || v.length !== 66)
					return "Must be a valid 0x-prefixed 32-byte hex key";
			},
		});
		handleCancel(privateKey);

		const jwt = await text({
			message: "Pinata JWT:",
			validate: (v) => {
				if (!v) return "Required";
			},
		});
		handleCancel(jwt);

		const gateway = await text({
			message: "Pinata Gateway URL:",
			placeholder: "https://your-gateway.mypinata.cloud",
			validate: (v) => {
				if (!v) return "Required";
			},
		});
		handleCancel(gateway);

		const chainName = await select({
			message: "Default chain:",
			options: [
				{
					value: SupportedNetworks.ArbitrumSepolia.name,
					label: "Arbitrum Sepolia",
				},
				{ value: SupportedNetworks.BaseSepolia.name, label: "Base Sepolia" },
			],
		});
		handleCancel(chainName);

		const stored: StoredConfig = {
			privateKey: privateKey as Hex,
			jwt: jwt as string,
			gateway: gateway as string,
			chainName: chainName as string,
		};

		if (!existsSync(CONFIG_DIR)) {
			mkdirSync(CONFIG_DIR, { recursive: true });
		}

		writeFileSync(CONFIG_PATH, JSON.stringify(stored, null, 2), "utf-8");
		// owner read/write only
		chmodSync(CONFIG_PATH, 0o600);

		outro(`Config saved to ${CONFIG_PATH}`);
	});

program
	.command("register")
	.description("Register a new datasource as an agent.")
	.argument("<name>", "Name of the datasource")
	.option("-s, --skip-card", "Skip agent card creation")
	.option("-e, --skip-erc", "Skip ERC-8007 registrion")
	.option("-d, --skip-ds", "Skip datasource registrion")
	.action(async (name: string, options) => {
		try {
			intro("Chain selection");

			const chain = await selectChain();

			outro(`Selected chain ${chain.name}`);

			let registerDatasource = options.skipDs ? false : true;
			let createAgentCard = options.skipCard ? false : true;
			let erc8004Registration = options.skipErc ? false : true;

			let description = "";

			const s = spinner();

			let datasourceAgentId;

			if (createAgentCard) {
				intro(`Agent Card Creation for ${chain.name}`);

				while (createAgentCard) {
					let builder: AgentCardBuilder = agentCardBuilder();

					builder.name(name);

					description = (await text({
						message: "Description of the Datasource:",
					})) as string;
					handleCancel(description);
					builder.description(description as string);

					const version = await text({
						message: "Agent Version:",
						placeholder: "1.0.0",
					});
					handleCancel(version);
					builder.version(version as string);

					const url = await text({
						message: "Base URL of the resource server:",
						placeholder: "https://example.com",
					});
					handleCancel(url);
					builder.url(url as string);

					const provider = await text({ message: "Organization name:" });
					handleCancel(provider);

					const providerUrl = await text({ message: "Provider URL:" });
					handleCancel(providerUrl);
					builder.provider(provider as string, providerUrl as string);

					let addSkill = true;

					while (addSkill) {
						const id = await text({
							message: "ID of the skill (this must be unique):",
						});
						handleCancel(id);

						const skillName = await text({ message: "Name of the skill:" });
						handleCancel(skillName);

						const skillDescription = await text({
							message: "Skill description:",
						});
						handleCancel(skillDescription);

						const tagsString = await text({
							message: "Skill Tags (comma separated - spaces will be removed):",
						});
						handleCancel(tagsString);
						const tagsArray = (tagsString as string)
							.replaceAll(" ", "")
							.split(",");

						builder.addSkill(
							id as string,
							skillName as string,
							skillDescription as string,
							tagsArray,
						);

						addSkill = (await confirm({
							message: "Would you like to add another skill?",
						})) as boolean;
						handleCancel(addSkill);
					}

					const agentCard = builder.build();

					note(JSON.stringify(agentCard, null, 2), "Your agent card:");

					const continueRegistration = (await confirm({
						message:
							"Does everything look correct? If not, agent card creation will start over.",
					})) as boolean;
					handleCancel(continueRegistration);
					createAgentCard = !continueRegistration;
				}
				outro("Agent Card Creation is Complete.");
			} else {
				note(
					"You are choosing to skip agent card creation. For ERC-8004 registration, we recommend you have an agent card either avaialbe\n" +
						"at a url like: https://this.example.com/.well-known/agent-card.json\n" +
						"This allows for the automatic population of the agent's skills and indexes their capabilities for search.\n" +
						"Similarly, if your agent will have tools available via an MCP endpoint we recommend that you have the server running to allow for population of tools, prompts, and resources.",
				);
			}

			intro(`Agent Registration for ${chain.name}`);
			let cfg = loadConfig();

			let agent0Sdk: SDK;

			const ipfsOrHttp = (await select({
				message: "Choose your registration flow",
				options: [
					{ value: "ipfs", label: "IPFS (Pinata)" },
					{ value: "http", label: "HTTP" },
				],
			})) as string;
			handleCancel(ipfsOrHttp);

			if (chain.id === 421614) {
				const registryOverrides = {
					421614: {
						IDENTITY: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
						REPUTATION: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
					},
				};

				const subgraphOverrides = {
					421614:
						"https://api.studio.thegraph.com/query/1742225/erc-8004-arbitrum-sepolia/version/latest",
				};

				if (ipfsOrHttp === "ipfs") {
					note(
						"You have chosen to register using the IPFS route. It is assumed that your Pinata JWT and Pinata Gateway are stored in your .env file.",
						"INFO",
					);

					agent0Sdk = new SDK({
						chainId: 421614,
						rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
						subgraphUrl:
							"https://api.studio.thegraph.com/query/1742225/erc-8004-arbitrum-sepolia/version/latest",
						registryOverrides,
						subgraphOverrides,
						ipfs: "pinata",
						pinataJwt: cfg.jwt,
						privateKey: cfg.privateKey,
					});
				} else {
					agent0Sdk = new SDK({
						chainId: 421614,
						rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
						subgraphUrl:
							"https://api.studio.thegraph.com/query/1742225/erc-8004-arbitrum-sepolia/version/latest",
						registryOverrides,
						subgraphOverrides,
						privateKey: cfg.privateKey,
					});
				}
			} else {
				if (ipfsOrHttp === "ipfs") {
					note(
						"You have chosen to register using the IPFS route. It is assumed that your Pinata JWT and Pinata Gateway are stored in your .env file.",
						"INFO",
					);
					agent0Sdk = new SDK({
						chainId: chain.id,
						rpcUrl: chain.rpcUrls.default.http[0],
						ipfs: "pinata",
						pinataJwt: cfg.jwt,
						privateKey: cfg.privateKey,
					});
				} else {
					agent0Sdk = new SDK({
						chainId: chain.id,
						rpcUrl: chain.rpcUrls.default.http[0],
						privateKey: cfg.privateKey,
					});
				}
			}

			let agent;
			while (erc8004Registration) {
				if (description) {
					const reuseDescription = (await confirm({
						message:
							"Would you like to re-use the description you submitted for your agent card?",
					})) as boolean;
					handleCancel(reuseDescription);
					if (!reuseDescription) {
						description = (await text({
							message: "Description of the Datasource:",
						})) as string;
						handleCancel(description);
					}
				} else {
					description = (await text({
						message: "Description of the Datasource:",
					})) as string;
					handleCancel(description);
				}

				agent = agent0Sdk.createAgent(name, description);

				const agentCardAvailable = (await confirm({
					message: createAgentCard
						? "Did you upload your agent card already?"
						: "Does your agent have an agent card?",
				})) as boolean;
				handleCancel(agentCardAvailable);
				if (agentCardAvailable) {
					const agentCardLocation = (await text({
						message: "Location of agent card:",
						placeholder: "https://example.com/.well-known/agentcard.json",
					})) as string;
					handleCancel(agentCardLocation);
					s.start("Calling A2A endpoint to retrieve skills and capabilities");
					await agent.setA2A(agentCardLocation);
					s.stop("A2A fetch complete");
				}

				const mcpAvailable = (await confirm({
					message: "Does your agent have an MCP endpoint?",
				})) as boolean;
				handleCancel(mcpAvailable);

				if (mcpAvailable) {
					const mcpEndpoint = (await text({
						message: "Location of MCP endpoint:",
						placeholder: "https://example.com/mcp",
					})) as string;
					handleCancel(mcpEndpoint);

					s.start("Retrieving tools, prompts, and resources");
					await agent.setMCP(mcpEndpoint);
					s.stop("MCP fetch complete");
				}

				const ensAvailable = (await confirm({
					message: "Does your agent have an ENS?",
				})) as boolean;
				handleCancel(ensAvailable);

				if (ensAvailable) {
					const ens = (await text({
						message: "Agent's ENS:",
						placeholder: "myagent.eth",
					})) as string;
					handleCancel(ens);
					agent.setENS(ens);
				}

				let selectTrustModels = true;

				while (selectTrustModels) {
					const trustModels = (await multiselect({
						message:
							"(Optional) Select trust models (use Space for selection and Enter for submission):",
						options: [
							{ value: "reputation", label: "Reputation" },
							{ value: "cryptoEconomic", label: "Crypto Economic" },
							{ value: "teeAttestation", label: "TEE Attestation" },
						],
						required: false,
					})) as string[];
					handleCancel(trustModels);

					if (!(trustModels.length > 0)) {
						selectTrustModels = !((await confirm({
							message: "You have chosen no trust models. Is this correct?",
						})) as boolean);
						handleCancel(selectTrustModels);
						if (!selectTrustModels) {
							agent.setTrust(
								trustModels.includes("reputation"),
								trustModels.includes("cryptoEconomic"),
								trustModels.includes("teeAttestation"),
							);
						}
					} else {
						selectTrustModels = false;
						agent.setTrust(
							trustModels.includes("reputation"),
							trustModels.includes("cryptoEconomic"),
							trustModels.includes("teeAttestation"),
						);
					}
				}

				let setMetadata = (await confirm({
					message: "Would you like to set metadata?",
				})) as boolean;
				handleCancel(setMetadata);

				if (setMetadata) {
					const metadata: Record<string, unknown> = {};
					while (setMetadata) {
						const key = (await text({
							message: "Key:",
							placeholder: "examples: version/category/etc.",
						})) as string;
						handleCancel(key);
						const value = (await text({
							message: "Value:",
							placeholder: "examples: 1.0.0/datasource/etc.",
						})) as string;
						handleCancel(value);
						metadata[key] = value;
						setMetadata = (await confirm({
							message: "Would you like to add more metadata?",
						})) as boolean;
					}
					agent.setMetadata(metadata);
				}

				agent.setActive(true);
				agent.setX402Support(true);

				note(
					JSON.stringify(agent.getRegistrationFile(), null, 2),
					"Your ERC-8004 registration:",
				);

				const completeRegistration = (await confirm({
					message:
						"Does everything look correct? If not, ERC registration will start over.",
				})) as boolean;
				handleCancel(completeRegistration);

				if (completeRegistration) {
					erc8004Registration = false;
					if (ipfsOrHttp === "http") {
						note(
							'You have chosen to use http to host your registration file. It is recommended to use https://example.com/.well-known/agent-registration.json for verifiers to treat you endpoint domain as "Verified"',
							"INFO",
						);
						note(
							JSON.stringify(agent.getRegistrationFile()),
							"Your Registration File",
						);
					} else {
						s.start("Registering with ERC-8004 registry");
						const regTx = await agent.registerIPFS();
						s.stop();
						s.start("Waiting for registration transaction to be confirmed");
						const { result: registrationFile } = await regTx.waitConfirmed();
						s.stop();
						datasourceAgentId = registrationFile.agentId;
						note(
							`Agent registration complete for agent name ${name}. They have the ID: ${datasourceAgentId}`,
						);
					}
				}
			}
			outro(`Agent Registration is Complete for ${chain.name}`);

			if (registerDatasource) {
				if (!datasourceAgentId) {
					const agentsList = await agent0Sdk.searchAgents({ name });
					if (agentsList.length > 0) {
						datasourceAgentId = agentsList[0].agentId;
					} else {
						throw new Error(
							`Agent with name ${name} was not found on the ERC-8004 on ${chain.name}`,
						);
					}
				}
				const fangorn = await getFangorn(chain);
				const id = await fangorn.registerDataSource(name, datasourceAgentId);
				note(`Data source ${name} registered with id = ${id}`);
			}

			process.exit(0);
		} catch (err) {
			console.error("Failed to register:", (err as Error).message);
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
	.option("-p, --price <price>", "price to access the file")
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
				// then we need a predicate builder
				// to take predicate string to actual class
				async (file) => {
					const commitment = await computeTagCommitment(
						owner,
						name,
						file.tag,
						options.price,
					);

					return new PaymentGadget({
						commitment: fieldToHex(commitment),
						chainName: "arbitrumSepolia",
						settlementTrackerContractAddress:
							"0x7c6ae9eb3398234eb69b2f3acfae69065505ff69" as Address,
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

program
	.command("list")
	.description("List contents (index) of a data source")
	.argument("<name>", "Data source name")
	.option(
		"-c, --chain <chain>",
		"The chain to use as the backend (arbitrumSepolia or baseSepolia)",
	)
	.action(async (name: string, options) => {
		try {
			const owner = getAccount().address;
			const chain = getChain(options.chain);
			const fangorn = await getFangorn(chain);
			const manifest = await fangorn.getManifest(owner, name);

			if (!manifest) {
				console.log("The data source is empty. \n");
				console.log(
					"Upload data with `fangorn upload <dataSourceName> <file> --price <set-price>",
				);
				process.exit(0);
			}
			console.log(`Datasource: ${name} (${owner})`);
			console.log(`Entries (${manifest.entries.length}):`);
			for (const entry of manifest.entries) {
				console.log(
					`  - ${entry.tag} | gadget descriptor: ${JSON.stringify(entry.gadgetDescriptor)} | cid: ${entry.cid}`,
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
	.description("Get data source info from contract")
	.argument("<name>", "Data source name")
	.option(
		"-c, --chain <chain>",
		"The chain to use as the backend (arbitrumSepolia or baseSepolia)",
	)
	.action(async (name: string, options) => {
		try {
			const owner = getAccount().address;
			const chain = getChain(options.chain);
			const fangorn = await getFangorn(chain);
			const vault = await fangorn.getDataSource(owner, name);

			console.log(`Datasource: ${name} (${owner})`);
			console.log(`Owner: ${vault.owner}`);
			console.log(
				`Manifest CID: ${vault.manifestCid == "" ? "Upload data with `fangorn upload <vaultName> <file> --price <set-price>`" : vault.manifestCid}`,
			);
			process.exit(0);
		} catch (err) {
			console.error("Failed to get vault info:", (err as Error).message);
			process.exit(1);
		}
	});

program
	.command("entry")
	.description("Get info about a specific entry")
	.argument("<name>", "Vault name")
	.argument("<tag>", "File tag")
	.option(
		"-c, --chain <chain>",
		"The chain to use as the backend (arbitrumSepolia or baseSepolia",
	)
	.action(async (name: string, tag: string, options) => {
		try {
			const owner = getAccount().address;
			const chain = getChain(options.chain);
			const fangorn = await getFangorn(chain);
			const entry = await fangorn.getDataSourceData(owner, name, tag);

			console.log(`Entry: ${tag}`);
			console.log(`  CID: ${entry.cid}`);
			console.log(
				`  Gadget Descriptor: ${JSON.stringify(entry.gadgetDescriptor)}`,
			);
			process.exit(0);
		} catch (err) {
			console.error("Failed to get entry:", (err as Error).message);
			process.exit(1);
		}
	});

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
