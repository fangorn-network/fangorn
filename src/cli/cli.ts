// #!/usr/bin/env node
// import { Command } from "commander";
// import {
//     intro,
//     outro,
//     text,
//     confirm,
//     select,
//     note,
//     spinner
// } from "@clack/prompts";
// import { createWalletClient, Hex, http, Address, Chain } from "viem";
// import { privateKeyToAccount, PrivateKeyAccount } from "viem/accounts";
// import { Fangorn } from "../fangorn.js";
// import { Filedata } from "../types/index.js";
// import "dotenv/config";
// import { PinataStorage } from "../providers/storage/index.js";
// import { AppConfig, FangornConfig, SupportedNetworks } from "../config.js";
// import { LitEncryptionService } from "../modules/encryption/lit.js";
// import { computeSchemaId, computeTagCommitment, fieldToHex } from "../utils/index.js";
// import { agentCardBuilder, AgentCardBuilder } from "../builders/a2aCardBuilder.js";
// import { SDK } from "agent0-sdk";
// import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
// import { basename, extname, join } from "path";
// import { homedir } from "os";
// import { getChain, handleCancel, parseGadgetArg, selectChain } from "./index.js";
// import { GADGET_REGISTRY, selectGadget } from "./registry.js";

// interface Config {
//     jwt: string;
//     gateway: string;
//     privateKey: Hex;
//     cfg: AppConfig;
// }

// interface StoredConfig {
//     privateKey: Hex;
//     jwt: string;
//     gateway: string;
//     chainName: string;
// }

// const CONFIG_DIR = join(homedir(), ".fangorn");
// const CONFIG_PATH = join(CONFIG_DIR, "config.json");

// let _config: Config | null = null;
// let _account: PrivateKeyAccount | null = null;
// let _fangorn: Fangorn | null = null;

// function loadConfig(): Config {
//     if (_config) return _config;

//     const privateKey = process.env.DELEGATOR_ETH_PRIVATE_KEY;
//     const jwt = process.env.PINATA_JWT;
//     const gateway = process.env.PINATA_GATEWAY;
//     const chainName = process.env.CHAIN_NAME;

//     if (privateKey && jwt && gateway && chainName) {
//         _config = buildConfig({ privateKey: privateKey as Hex, jwt, gateway, chainName });
//         return _config;
//     }

//     if (existsSync(CONFIG_PATH)) {
//         const stored: StoredConfig = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as StoredConfig;
//         _config = buildConfig(stored);
//         return _config;
//     }

//     throw new Error(
//         "No configuration found. Run `fangorn init` to set up your credentials, " +
//         "or set DELEGATOR_ETH_PRIVATE_KEY, PINATA_JWT, PINATA_GATEWAY, and CHAIN_NAME env vars.",
//     );
// }

// function buildConfig({ privateKey, jwt, gateway, chainName }: StoredConfig): Config {
//     let cfg: AppConfig = FangornConfig.BaseSepolia;
//     if (chainName === SupportedNetworks.ArbitrumSepolia.name) {
//         cfg = FangornConfig.ArbitrumSepolia;
//     }
//     return { privateKey, jwt, gateway, cfg };
// }

// async function resolveSchemaId(fangorn: Fangorn, schemaOrId: string): Promise<Hex> {
//     if (schemaOrId.startsWith("0x") && schemaOrId.length === 66) {
//         return schemaOrId as Hex;
//     }
//     const id = computeSchemaId(schemaOrId);
//     const exists = await fangorn.getSchemaRegistry().schemaExists(id);
//     if (!exists) {
//         throw new Error(`Schema "${schemaOrId}" not found on-chain. Register it first with \`fangorn register\`.`);
//     }
//     return id;
// }

// function getAccount(): PrivateKeyAccount {
//     if (_account) return _account;
//     _account = privateKeyToAccount(loadConfig().privateKey);
//     return _account;
// }

// async function getFangorn(chain: Chain): Promise<Fangorn> {
//     if (_fangorn) return _fangorn;

//     const cfg = loadConfig();
//     const walletClient = createWalletClient({
//         account: getAccount(),
//         transport: http(cfg.cfg.rpcUrl),
//         chain,
//     });

//     const domain = process.env.DOMAIN ?? "localhost:3000";
//     const storage = new PinataStorage(cfg.jwt, cfg.gateway);
//     const encryptionService = await LitEncryptionService.init(cfg.cfg.chainName);

//     _fangorn = Fangorn.init(walletClient, storage, encryptionService, domain, cfg.cfg);
//     return _fangorn;
// }

// const program = new Command();
// program.name("Fangorn").description("CLI for Fangorn").version("0.0.2");

// // -----------------------------------------------------------------------------
// // init
// // -----------------------------------------------------------------------------

// program
//     .command("init")
//     .description("Configure your Fangorn credentials")
//     .action(async () => {
//         intro("Fangorn Setup");

//         const privateKey = await text({
//             message: "Your wallet private key (stored locally, never transmitted):",
//             placeholder: "0x...",
//             validate: (v) => {
//                 if (!v) return "Private key does not exist";
//                 if (!v.startsWith("0x") || v.length !== 66)
//                     return "Must be a valid 0x-prefixed 32-byte hex key";
//             },
//         });
//         handleCancel(privateKey);

//         const jwt = await text({
//             message: "Pinata JWT:",
//             validate: (v) => { if (!v) return "Required"; },
//         });
//         handleCancel(jwt);

//         const gateway = await text({
//             message: "Pinata Gateway URL:",
//             placeholder: "https://your-gateway.mypinata.cloud",
//             validate: (v) => { if (!v) return "Required"; },
//         });
//         handleCancel(gateway);

//         const chainName = await select({
//             message: "Default chain:",
//             options: [
//                 { value: SupportedNetworks.ArbitrumSepolia.name, label: "Arbitrum Sepolia" },
//                 { value: SupportedNetworks.BaseSepolia.name, label: "Base Sepolia" },
//             ],
//         });
//         handleCancel(chainName);

//         const stored: StoredConfig = {
//             privateKey: privateKey as Hex,
//             jwt: jwt as string,
//             gateway: gateway as string,
//             chainName: chainName as string,
//         };

//         if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
//         writeFileSync(CONFIG_PATH, JSON.stringify(stored, null, 2), "utf-8");
//         chmodSync(CONFIG_PATH, 0o600);

//         outro(`Config saved to ${CONFIG_PATH}`);
//     });

// // -----------------------------------------------------------------------------
// // register (schema + ERC-8004 only)
// // -----------------------------------------------------------------------------

// program
//     .command("register")
//     .description("Register a schema and ERC-8004 agent identity.")
//     .argument("<name>", "Name of the schema / agent")
//     .option("-s, --skip-card", "Skip agent card creation")
//     .option("-e, --skip-erc", "Skip ERC-8004 registration")
//     .option("-z, --skip-schema", "Skip schema registry")
//     .action(async (name: string, options: { skipCard: boolean; skipErc: boolean; skipSchema?: boolean }) => {
//         try {
//             intro("Chain selection");
//             const chain = await selectChain();
//             outro(`Selected chain ${chain.name}`);

//             let createAgentCard = !options.skipCard;
//             let erc8004Registration = !options.skipErc;
//             let description = "";
//             const s = spinner();
//             let datasourceAgentId: string | undefined;

//             // --- Agent Card ---
//             if (createAgentCard) {
//                 intro(`Agent Card Creation for ${chain.name}`);
//                 while (createAgentCard) {
//                     const builder: AgentCardBuilder = agentCardBuilder();
//                     builder.name(name);

//                     description = (await text({ message: "Description:" })) as string;
//                     handleCancel(description);
//                     builder.description(description);

//                     const version = await text({ message: "Agent Version:", placeholder: "1.0.0" });
//                     handleCancel(version);
//                     builder.version(version as string);

//                     const url = await text({ message: "Base URL:", placeholder: "https://example.com" });
//                     handleCancel(url);
//                     builder.url(url as string);

//                     const provider = await text({ message: "Organization name:" });
//                     handleCancel(provider);
//                     const providerUrl = await text({ message: "Provider URL:" });
//                     handleCancel(providerUrl);
//                     builder.provider(provider as string, providerUrl as string);

//                     let addSkill = true;
//                     while (addSkill) {
//                         const id = await text({ message: "Skill ID:" });
//                         handleCancel(id);
//                         const skillName = await text({ message: "Skill name:" });
//                         handleCancel(skillName);
//                         const skillDescription = await text({ message: "Skill description:" });
//                         handleCancel(skillDescription);
//                         const tagsString = await text({ message: "Tags (comma-separated):" });
//                         handleCancel(tagsString);
//                         const tagsArray = (tagsString as string).replaceAll(" ", "").split(",");
//                         builder.addSkill(id as string, skillName as string, skillDescription as string, tagsArray);
//                         addSkill = (await confirm({ message: "Add another skill?" })) as boolean;
//                         handleCancel(addSkill);
//                     }

//                     const agentCard = builder.build();
//                     note(JSON.stringify(agentCard, null, 2), "Your agent card:");
//                     const ok = (await confirm({ message: "Does everything look correct?" })) as boolean;
//                     handleCancel(ok);
//                     createAgentCard = !ok;
//                 }
//                 outro("Agent Card Creation complete.");
//             }

//             // --- ERC-8004 ---
//             const cfg = loadConfig();
//             let agent0Sdk: SDK;

//             const ipfsOrHttp = (await select({
//                 message: "Choose your registration flow",
//                 options: [
//                     { value: "ipfs", label: "IPFS (Pinata)" },
//                     { value: "http", label: "HTTP" },
//                 ],
//             })) as string;
//             handleCancel(ipfsOrHttp);

//             if (chain.id === 421614) {
//                 const registryOverrides = {
//                     421614: {
//                         IDENTITY: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
//                         REPUTATION: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
//                     },
//                 };
//                 const subgraphOverrides = {
//                     421614: "https://api.studio.thegraph.com/query/1742225/erc-8004-arbitrum-sepolia/version/latest",
//                 };
//                 agent0Sdk = new SDK({
//                     chainId: 421614,
//                     rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
//                     subgraphUrl: subgraphOverrides[421614],
//                     registryOverrides,
//                     subgraphOverrides,
//                     ...(ipfsOrHttp === "ipfs" ? { ipfs: "pinata", pinataJwt: cfg.jwt } : {}),
//                     privateKey: cfg.privateKey,
//                 });
//             } else {
//                 agent0Sdk = new SDK({
//                     chainId: chain.id,
//                     rpcUrl: chain.rpcUrls.default.http[0],
//                     ...(ipfsOrHttp === "ipfs" ? { ipfs: "pinata", pinataJwt: cfg.jwt } : {}),
//                     privateKey: cfg.privateKey,
//                 });
//             }

//             let agent;
//             while (erc8004Registration) {
//                 if (!description) {
//                     description = (await text({ message: "Description:" })) as string;
//                     handleCancel(description);
//                 } else {
//                     const reuse = (await confirm({ message: "Re-use description from agent card?" })) as boolean;
//                     handleCancel(reuse);
//                     if (!reuse) {
//                         description = (await text({ message: "Description:" })) as string;
//                         handleCancel(description);
//                     }
//                 }

//                 agent = agent0Sdk.createAgent(name, description);

//                 const agentCardAvailable = (await confirm({ message: "Does your agent have an agent card?" })) as boolean;
//                 handleCancel(agentCardAvailable);
//                 if (agentCardAvailable) {
//                     const loc = (await text({ message: "Agent card URL:", placeholder: "https://example.com/.well-known/agentcard.json" })) as string;
//                     handleCancel(loc);
//                     s.start("Fetching agent card");
//                     await agent.setA2A(loc);
//                     s.stop("Agent card fetched");
//                 }

//                 const mcpAvailable = (await confirm({ message: "Does your agent have an MCP endpoint?" })) as boolean;
//                 handleCancel(mcpAvailable);
//                 if (mcpAvailable) {
//                     const endpoint = (await text({ message: "MCP endpoint:", placeholder: "https://example.com/mcp" })) as string;
//                     handleCancel(endpoint);
//                     s.start("Fetching MCP tools");
//                     await agent.setMCP(endpoint);
//                     s.stop("MCP tools fetched");
//                 }

//                 const ensAvailable = (await confirm({ message: "Does your agent have an ENS?" })) as boolean;
//                 handleCancel(ensAvailable);
//                 if (ensAvailable) {
//                     const ens = (await text({ message: "ENS:", placeholder: "myagent.eth" })) as string;
//                     handleCancel(ens);
//                     agent.setENS(ens);
//                 }

//                 agent.setActive(true);
//                 agent.setX402Support(true);

//                 note(JSON.stringify(agent.getRegistrationFile(), null, 2), "Your ERC-8004 registration:");

//                 const ok = (await confirm({ message: "Does everything look correct?" })) as boolean;
//                 handleCancel(ok);

//                 if (ok) {
//                     erc8004Registration = false;
//                     if (ipfsOrHttp === "http") {
//                         note(JSON.stringify(agent.getRegistrationFile()), "Your Registration File");
//                     } else {
//                         s.start("Registering with ERC-8004 registry");
//                         const regTx = await agent.registerIPFS();
//                         s.stop();
//                         s.start("Waiting for confirmation");
//                         const { result: registrationFile } = await regTx.waitConfirmed();
//                         s.stop();
//                         datasourceAgentId = registrationFile.agentId ?? "agentId wasn't found";
//                         note(`Agent registered with ID: ${datasourceAgentId}`);
//                     }
//                 }
//             }
//             outro(`Agent Registration complete for ${chain.name}`);

//             // --- Schema Registry ---
//             if (!options.skipSchema) {
//                 intro("Schema Registration");

//                 const schemaFilePath = (await text({
//                     message: "Path to your JSON schema file:",
//                     placeholder: "./schema.json",
//                     validate: (v) => {
//                         if (!v) return "Required";
//                         if (!existsSync(v)) return `File not found: ${v}`;
//                         if (extname(v).toLowerCase() !== ".json") return "Must be a .json file";
//                     },
//                 })) as string;
//                 handleCancel(schemaFilePath);

//                 const schemaName = (await text({
//                     message: "Schema name (e.g. fangorn.music.v1):",
//                     placeholder: "fangorn.myapp.v1",
//                     validate: (v) => { if (!v) return "Required"; },
//                 })) as string;
//                 handleCancel(schemaName);

//                 // Parse and pretty-print so the user can confirm what they're registering
//                 let schemaJson: unknown;
//                 try {
//                     schemaJson = JSON.parse(readFileSync(schemaFilePath, "utf-8"));
//                 } catch {
//                     throw new Error(`Failed to parse ${schemaFilePath} as JSON`);
//                 }
//                 note(JSON.stringify(schemaJson, null, 2), "Schema file contents:");

//                 const ok = (await confirm({ message: "Upload and register this schema?" })) as boolean;
//                 handleCancel(ok);
//                 if (!ok) {
//                     outro("Schema registration skipped.");
//                     process.exit(0);
//                 }

//                 const cfg = loadConfig();
//                 const storage = new PinataStorage(cfg.jwt, cfg.gateway);

//                 const s = spinner();
//                 s.start("Uploading schema to IPFS...");
//                 const specCid = await storage.store(schemaJson, {
//                     metadata: `${schemaName}.schema.json`,
//                 });

//                 s.stop(`Schema uploaded: ${specCid}`);

//                 const fangorn = await getFangorn(chain);
//                 s.start("Registering schema on-chain...");
//                 const { schemaId } = await fangorn.getSchemaRegistry().registerSchema(
//                     schemaName,
//                     specCid,
//                     datasourceAgentId ?? "",
//                 );
//                 s.stop();

//                 note(
//                     `Schema ID: ${schemaId}\nSpec CID:  ${specCid}`,
//                     "Schema registered",
//                 );
//             }

//             process.exit(0);
//         } catch (err) {
//             console.error("Failed to register:", (err as Error).message);
//             process.exit(1);
//         }
//     });

// // -----------------------------------------------------------------------------
// // upload
// // -----------------------------------------------------------------------------

// program
//     .command("upload")
//     .description("Upload file(s) to your data source")
//     .argument("<files...>", "File path(s) to upload")
//     .requiredOption("-s, --schema-id <schemaOrId>", "Schema name (e.g. fangorn.music.v1) or ID (bytes32 hex)")
//     .option("-c, --chain <chain>", "Chain to use (arbitrumSepolia or baseSepolia)")
//     .option("-g, --gadget <type(args)>", "Gadget to use (e.g. Payment(0.000001))")
//     .option("-o, --overwrite", "Overwrite existing manifest contents")
//     .action(async (files: string[], options: { chain: string; gadget?: string; schemaId: Hex; overwrite?: boolean }) => {
//         try {
//             const owner = getAccount().address;
//             const chain = getChain(options.chain);
//             const fangorn = await getFangorn(chain);

//             // Resolve schema name → ID if not already a bytes32 hex
//             let schemaId: Hex;
//             if (options.schemaId.startsWith("0x") && options.schemaId.length === 66) {
//                 schemaId = options.schemaId;
//             } else {
//                 const s = spinner();
//                 s.start(`Resolving schema "${options.schemaId}"...`);
//                 const exists = await fangorn.getSchemaRegistry().schemaExists(
//                     computeSchemaId(options.schemaId)
//                 );
//                 if (!exists) {
//                     s.stop();
//                     throw new Error(`Schema "${options.schemaId}" not found on-chain. Register it first with \`fangorn register\`.`);
//                 }
//                 schemaId = computeSchemaId(options.schemaId);
//                 s.stop(`Resolved: ${schemaId}`);
//             }

//             const filedata: Filedata[] = files.map((filepath) => {
//                 const data = readFileSync(filepath);
//                 const tag = basename(filepath);
//                 const extension = extname(filepath);
//                 return {
//                     tag,
//                     data: data.toString("base64"),
//                     extension,
//                     fileType: getMimeType(extension),
//                 };
//             });

//             const cid = await fangorn.upload(
//                 filedata,
//                 async (file) => {
//                     if (options.gadget) {
//                         const { type, args } = parseGadgetArg(options.gadget);
//                         if (!(type in GADGET_REGISTRY))
//                             throw new Error(`Unknown gadget type: ${type}`);
//                         const def = GADGET_REGISTRY[type as keyof typeof GADGET_REGISTRY];

//                         const params: Record<string, unknown> = {};
//                         def.argSchema.forEach((key, i) => { params[key] = args[i]; });

//                         const commitment = computeTagCommitment(owner, file.tag, args[0] ?? "0");
//                         params.commitment = fieldToHex(commitment);
//                         params.chainName = options.chain;
//                         params.settlementTrackerContractAddress =
//                             options.chain === "arbitrumSepolia"
//                                 ? "0x7c6ae9eb3398234eb69b2f3acfae69065505ff69"
//                                 : "0x708751829f5f5f584da4142b62cd5cc9235c8a18";
//                         params.pinataJwt = loadConfig().jwt;
//                         return def.build(params);
//                     }
//                     return selectGadget(owner, file.tag, "0");
//                 },
//                 schemaId,
//                 !!options.overwrite,
//             );

//             console.log(`Upload complete! Manifest CID: ${cid}`);
//             process.exit(0);
//         } catch (err) {
//             console.error("Failed to upload:", (err as Error).message);
//             process.exit(1);
//         }
//     });

// // -----------------------------------------------------------------------------
// // list
// // -----------------------------------------------------------------------------

// program
//     .command("list")
//     .description("List contents of a manifest under a schema")
//     .requiredOption("-s, --schema-id <schemaId>", "Schema ID (bytes32 hex)")
//     .option("-c, --chain <chain>", "Chain to use (arbitrumSepolia or baseSepolia)")
//     .option("--owner <address>", "Owner address (defaults to your own)")
//     .action(async (options: { chain: string; schemaId: Hex; owner?: Address }) => {
//         try {
//             const self = getAccount().address;
//             const owner = options.owner ?? self;
//             const chain = getChain(options.chain);
//             const fangorn = await getFangorn(chain);
//             const schemaId = await resolveSchemaId(fangorn, options.schemaId);
//             const manifest = await fangorn.getManifest(owner, schemaId);

//             if (!manifest) {
//                 console.log("No manifest found for this owner + schema.");
//                 console.log("Upload data with `fangorn upload <file> --schema-id <id>`");
//                 process.exit(0);
//             }

//             console.log(`Owner:    ${owner}`);
//             console.log(`Schema:   ${options.schemaId}`);
//             console.log(`Entries (${String(manifest.entries.length)}):`);
//             for (const entry of manifest.entries) {
//                 console.log(
//                     `  - ${entry.tag} | gadget: ${JSON.stringify(entry.gadgetDescriptor)} | cid: ${entry.cid}`,
//                 );
//             }
//             process.exit(0);
//         } catch (err) {
//             console.error("Failed to list:", (err as Error).message);
//             process.exit(1);
//         }
//     });

// // -----------------------------------------------------------------------------
// // info
// // -----------------------------------------------------------------------------

// program
//     .command("info")
//     .description("Get data source info from the contract for a given schema")
//     .requiredOption("-s, --schema-id <schemaId>", "Schema ID (bytes32 hex)")
//     .option("-c, --chain <chain>", "Chain to use (arbitrumSepolia or baseSepolia)")
//     .option("--owner <address>", "Owner address (defaults to your own)")
//     .action(async (options: { chain: string; schemaId: Hex; owner?: Address }) => {
//         try {
//             const self = getAccount().address;
//             const owner = options.owner ?? self;
//             const chain = getChain(options.chain);
//             const fangorn = await getFangorn(chain);
//             const schemaId = await resolveSchemaId(fangorn, options.schemaId);
//             const ds = await fangorn.getDatasourceRegistry().getManifest(owner, schemaId);

//             console.log(`Owner:        ${owner}`);
//             console.log(`Schema ID:    ${options.schemaId}`);
//             console.log(`Version:      ${String(ds.version)}`);
//             console.log(`Manifest CID: ${ds.manifestCid || "No manifest yet — upload with `fangorn upload <file> --schema-id <id>`"}`);
//             process.exit(0);
//         } catch (err) {
//             console.error("Failed to get info:", (err as Error).message);
//             process.exit(1);
//         }
//     });

// // -----------------------------------------------------------------------------
// // entry
// // -----------------------------------------------------------------------------

// program
//     .command("entry")
//     .description("Get info about a specific entry by tag")
//     .argument("<tag>", "File tag")
//     .requiredOption("-s, --schema-id <schemaId>", "Schema ID (bytes32 hex)")
//     .option("--owner <address>", "Owner address (defaults to your own)")
//     .option("-c, --chain <chain>", "Chain to use (arbitrumSepolia or baseSepolia)")
//     .action(async (tag: string, options: { chain: string; schemaId: Hex; owner?: Address }) => {
//         try {
//             const self = getAccount().address;
//             const owner = options.owner ?? self;
//             const chain = getChain(options.chain);
//             const fangorn = await getFangorn(chain);
//             const schemaId = await resolveSchemaId(fangorn, options.schemaId);
//             const entry = await fangorn.getEntry(owner, schemaId, tag);

//             console.log(`Entry:              ${tag}`);
//             console.log(`  CID:              ${entry.cid}`);
//             console.log(`  Gadget Descriptor: ${JSON.stringify(entry.gadgetDescriptor)}`);
//             process.exit(0);
//         } catch (err) {
//             console.error("Failed to get entry:", (err as Error).message);
//             process.exit(1);
//         }
//     });

// // -----------------------------------------------------------------------------
// // decrypt
// // -----------------------------------------------------------------------------

// program
//     .command("decrypt")
//     .description("Decrypt a file from a data source")
//     .argument("<owner>", "Owner address of the data source")
//     .argument("<tag>", "File tag")
//     .requiredOption("-s, --schema-id <schemaId>", "Schema ID (bytes32 hex)")
//     .option("-c, --chain <chain>", "Chain to use (arbitrumSepolia or baseSepolia)")
//     .option("-o, --output <path>", "Output file path")
//     .action(async (owner: Address, tag: string, options: { chain: string; schemaId: Hex; output?: string }) => {
//         try {
//             const chain = getChain(options.chain);
//             const fangorn = await getFangorn(chain);
//             const schemaId = await resolveSchemaId(fangorn, options.schemaId);
//             const decrypted = await fangorn.decryptFile(owner, schemaId, tag);

//             if (options.output) {
//                 writeFileSync(options.output, Buffer.from(decrypted));
//                 console.log(`Decrypted file saved to: ${options.output}`);
//             } else {
//                 const buf = Buffer.from(decrypted);
//                 process.stdout.write(atob(buf.toString()));
//                 process.stdout.write("\n");
//             }
//             process.exit(0);
//         } catch (err) {
//             console.error("Failed to decrypt:", (err as Error).message);
//             process.exit(1);
//         }
//     });

// // -----------------------------------------------------------------------------

// function getMimeType(ext: string): string {
//     const types: Record<string, string> = {
//         ".txt": "text/plain",
//         ".json": "application/json",
//         ".html": "text/html",
//         ".css": "text/css",
//         ".js": "application/javascript",
//         ".png": "image/png",
//         ".jpg": "image/jpeg",
//         ".jpeg": "image/jpeg",
//         ".gif": "image/gif",
//         ".pdf": "application/pdf",
//         ".mp3": "audio/mpeg",
//         ".mp4": "video/mp4",
//     };
//     return types[ext.toLowerCase()] || "application/octet-stream";
// }

// program.parse();