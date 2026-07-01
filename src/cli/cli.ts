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
    log,
} from "@clack/prompts";
import {
    type Hex,
    type Address,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
    chmodSync,
    createReadStream,
    openSync,
    readSync,
    closeSync,
} from "fs";
import streamArray from "stream-json/streamers/stream-array.js";
import { extname, join } from "path";
import { homedir } from "os";
import "dotenv/config";

import { Fangorn } from "../fangorn.js";
import { handleCancel, selectChain } from "./index.js";
import type { SchemaDefinition } from "../roles/schema/index.js";
import { AgentConfig } from "../types/index.js";
import { AppConfig, FangornConfig, SupportedNetworks } from "../config.js";
import { PublishRecord } from "../roles/publisher/types.js";
import { LocalRepo } from "../roles/repo/index.js";
import { ObjectStore } from "../objects/store.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface StoredConfig {
    privateKey: Hex;
    chainName: string;
    pinataJwt: string;
    pinataGateway: string;
    workerUrl: string;
}

interface Config {
    privateKey: Hex;
    cfg: AppConfig;
    pinataJwt: string;
    pinataGateway: string;
    workerUrl: string;
}

// ─── Config management ────────────────────────────────────────────────────────

const CONFIG_DIR = join(homedir(), ".fangorn");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

let _config: Config | null = null;
let _account: PrivateKeyAccount | null = null;
let _fangorn: Fangorn | null = null;

function resolveAppConfig(chainName: string): AppConfig {
    if (chainName === SupportedNetworks.ArbitrumSepolia.name) {
        return FangornConfig.ArbitrumSepolia;
    }
    return FangornConfig.BaseSepolia;
}

function loadConfig(): Config {
    if (_config) return _config;

    const privateKey = process.env.DELEGATOR_ETH_PRIVATE_KEY;
    const pinataJwt = process.env.PINATA_JWT;
    const pinataGateway = process.env.PINATA_GATEWAY;
    const chainName = process.env.CHAIN_NAME;
    const workerUrl = process.env.WORKER_URL;

    if (privateKey || pinataJwt || pinataGateway || chainName) {
        const missing: string[] = [];
        if (!privateKey) missing.push("DELEGATOR_ETH_PRIVATE_KEY");
        if (!pinataJwt) missing.push("PINATA_JWT");
        if (!pinataGateway) missing.push("PINATA_GATEWAY");
        if (!chainName) missing.push("CHAIN_NAME");

        if (missing.length > 0) {
            throw new Error(
                `Incomplete environment configuration. Missing: ${missing.join(", ")}\n` +
                `Set all required env vars or run \`fangorn init\` to use a config file.`,
            );
        }

        _config = {
            privateKey: privateKey as Hex,
            cfg: resolveAppConfig(chainName ?? ""),
            pinataJwt: pinataJwt ?? "",
            pinataGateway: pinataGateway ?? "",
            workerUrl: workerUrl ?? "",
        };

        return _config;
    }

    if (existsSync(CONFIG_PATH)) {
        const stored = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as StoredConfig;
        _config = {
            privateKey: stored.privateKey,
            cfg: resolveAppConfig(stored.chainName),
            pinataJwt: stored.pinataJwt,
            pinataGateway: stored.pinataGateway,
            workerUrl: stored.workerUrl,
        };
        return _config;
    }

    throw new Error(
        "No configuration found. Run `fangorn init` or set the required env vars:\n" +
        "  DELEGATOR_ETH_PRIVATE_KEY, PINATA_JWT, PINATA_GATEWAY, CHAIN_NAME",
    );
}

function getAccount(): PrivateKeyAccount {
    if (_account) return _account;
    _account = privateKeyToAccount(loadConfig().privateKey);
    return _account;
}

function getFangorn(): Fangorn {
    if (_fangorn) return _fangorn;

    const cfg = loadConfig();

    const agentConfig: AgentConfig = { privateKey: cfg.privateKey, pinataJwt: cfg.pinataJwt };

    _fangorn = Fangorn.create({
        privateKey: cfg.privateKey,
        storage: {
            pinata: {
                jwt: cfg.pinataJwt,
                gateway: cfg.pinataGateway,
            },
        },
        domain: "localhost",
        config: cfg.cfg,
        agentConfig,
    });
    return _fangorn;
}

async function resolveSchemaId(fangorn: Fangorn, schemaNameOrId: string): Promise<Hex> {
    try {
        return await fangorn.getSchemaRegistry().schemaId(
            /^0x[0-9a-fA-F]{64}$/.test(schemaNameOrId)
                ? (schemaNameOrId as Hex)
                : schemaNameOrId,
        );
    } catch {
        throw new Error(
            `Schema "${schemaNameOrId}" not found on-chain. Register it with \`fangorn schema register\`.`,
        );
    }
}

// ─── CLI root ─────────────────────────────────────────────────────────────────

const program = new Command();
program.name("fangorn").description("Fangorn Network CLI").version("0.2.1");

// ─── init ─────────────────────────────────────────────────────────────────────

program
    .command("init")
    .description("Configure your Fangorn credentials")
    .action(async () => {
        intro("Fangorn Setup");

        const privateKey = await text({
            message: "Wallet private key (stored locally, never transmitted):",
            placeholder: "0x...",
            validate: (v) => {
                if (!v) return "Required";
                if (!v.startsWith("0x") || v.length !== 66)
                    return "Must be a valid 0x-prefixed 32-byte hex key";
            },
        });
        handleCancel(privateKey);

        const chainName = await select({
            message: "Default chain:",
            options: [
                { value: SupportedNetworks.ArbitrumSepolia.name, label: "Arbitrum Sepolia" },
                { value: SupportedNetworks.BaseSepolia.name, label: "Base Sepolia" },
            ],
        });
        handleCancel(chainName);

        const pinataJwt = await text({
            message: "Pinata JWT:",
            validate: (v) => { if (!v) return "Required"; },
        });
        handleCancel(pinataJwt);

        const pinataGateway = await text({
            message: "Pinata Gateway URL:",
            placeholder: "https://your-gateway.mypinata.cloud",
            validate: (v) => { if (!v) return "Required"; },
        });
        handleCancel(pinataGateway);

        const workerUrl = await text({
            message: "Fangorn access worker URL:",
            placeholder: "https://fangorn-access-worker.your-subdomain.workers.dev",
            validate: (v) => { if (!v) return "Required"; },
        });
        handleCancel(workerUrl);

        const stored: StoredConfig = {
            privateKey: privateKey as Hex,
            chainName: chainName as string,
            pinataJwt: pinataJwt as string,
            pinataGateway: pinataGateway as string,
            workerUrl: workerUrl as string,
        };

        if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
        writeFileSync(CONFIG_PATH, JSON.stringify(stored, null, 2), "utf-8");
        chmodSync(CONFIG_PATH, 0o600);

        outro(`Config saved to ${CONFIG_PATH}`);
    });

// ─── schema ───────────────────────────────────────────────────────────────────

const schemaCmd = program
    .command("schema")
    .description("Schema registry operations");

schemaCmd
    .command("register")
    .description("Register a schema on-chain")
    .argument("<name>", "Schema name")
    .action(async (name: string) => {
        try {
            intro("Chain selection");
            const chain = await selectChain();
            outro(`Selected chain: ${chain.name}`);

            const fangorn = getFangorn();

            intro("Schema Registration");

            const schemaFilePath = (await text({
                message: "Path to your JSON schema file:",
                placeholder: "./schema.json",
                validate: (v) => {
                    if (!v) return "Required";
                    if (!existsSync(v)) return `File not found: ${v}`;
                    if (extname(v).toLowerCase() !== ".json") return "Must be a .json file";
                },
            })) as string;
            handleCancel(schemaFilePath);

            let definition: SchemaDefinition;
            try {
                definition = JSON.parse(readFileSync(schemaFilePath, "utf-8")) as SchemaDefinition;
            } catch {
                throw new Error(`Failed to parse ${schemaFilePath} as JSON`);
            }

            note(JSON.stringify(definition, null, 2), "Schema definition:");
            const ok = (await confirm({ message: "Register this schema?" })) as boolean;
            handleCancel(ok);
            if (!ok) { outro("Cancelled."); process.exit(0); }

            const s = spinner();
            s.start("Registering schema...");
            const { schemaId, schemaCid } = await fangorn.schema.register({
                name,
                definition,
            });
            s.stop();

            note(`Schema ID: ${schemaId}\nCID:       ${schemaCid}`, "Schema registered");
            process.exit(0);
        } catch (err) {
            console.error("Failed:", (err as Error).message);
            process.exit(1);
        }
    });

schemaCmd
    .command("get")
    .description("Fetch a registered schema by name")
    .argument("<name>", "Schema name")
    .action(async (name: string) => {
        try {
            const fangorn = getFangorn();
            const s = spinner();

            s.start(`Fetching schema "${name}"...`);
            const schema = await fangorn.schema.get(name);
            s.stop();

            if (!schema) {
                log.error(`Schema "${name}" not found.`);
                process.exit(1);
            }

            note(JSON.stringify(schema, null, 2), `Schema: ${name}`);
            process.exit(0);
        } catch (err) {
            console.error("Failed:", (err as Error).message);
            process.exit(1);
        }
    });

// ─── publish ──────────────────────────────────────────────────────────────────

/**
 * Cheaply read the first non-whitespace byte of a file without loading it.
 * Used to decide between streaming an array ("[") and reading a single object.
 */
function peekFirstNonWsByte(filepath: string): number | undefined {
    const fd = openSync(filepath, "r");
    try {
        const buf = Buffer.alloc(64);
        let offset = 0;
        for (;;) {
            const bytesRead = readSync(fd, buf, 0, buf.length, offset);
            if (bytesRead === 0) return undefined;
            for (let i = 0; i < bytesRead; i++) {
                const b = buf[i];
                // skip ASCII whitespace: space, tab, LF, CR
                if (b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) return b;
            }
            offset += bytesRead;
        }
    } finally {
        closeSync(fd);
    }
}

/**
 * Lazily stream PublishRecords out of one or more JSON files. A file whose first
 * non-whitespace byte is "[" is streamed as an array (never fully resident);
 * anything else is read as a single top-level object.
 */
async function* streamRecordsFromFiles(files: string[]): AsyncIterable<PublishRecord> {
    for (const filepath of files) {
        if (peekFirstNonWsByte(filepath) === 0x5b /* "[" */) {
            const pipeline = createReadStream(filepath).pipe(streamArray.withParserAsStream());
            for await (const { value } of pipeline as AsyncIterable<{ value: PublishRecord }>) {
                yield value;
            }
        } else {
            yield JSON.parse(readFileSync(filepath, "utf-8")) as PublishRecord;
        }
    }
}

const publishCmd = program
    .command("publish")
    .description("Publisher operations");

publishCmd
    .command("upload")
    .description("Publish file handle(s) under a schema")
    .argument("<files...>", "JSON file(s) containing PublishRecord(s)")
    .requiredOption("-s, --schema <schemaName>", "Schema name or bytes32 ID")
    .requiredOption("-d, --dataset <datasetName>", "Dataset name (groups entries under a manifest)")
    .option("--chunk-size <n>", "Records per chunk (default 1000)", (v) => parseInt(v, 10))
    .option("--concurrency <n>", "Parallel chunk uploads (default 10)", (v) => parseInt(v, 10))
    .action(async (
        files: string[],
        options: { schema: string; dataset: string; chunkSize?: number; concurrency?: number },
    ) => {
        try {
            const fangorn = getFangorn();
            const s = spinner();

            // Stream records lazily so a multi-GB array file is never fully
            // resident in memory. publishRecords/RecordSetBuilder consume the
            // async iterable directly, and publish() applies upload backpressure.
            let published = 0;
            async function* streamRecords(): AsyncIterable<PublishRecord> {
                for (const filepath of files) {
                    if (peekFirstNonWsByte(filepath) === 0x5b /* "[" */) {
                        const pipeline = createReadStream(filepath).pipe(
                            streamArray.withParserAsStream(),
                        );
                        for await (const { value } of pipeline as AsyncIterable<{ value: PublishRecord }>) {
                            yield value;
                            if (++published % 10_000 === 0) {
                                s.message(`Publishing... ${published.toLocaleString()} records read`);
                            }
                        }
                    } else {
                        // Single top-level object (or non-array): tiny, read directly.
                        const parsed = JSON.parse(readFileSync(filepath, "utf-8")) as PublishRecord;
                        yield parsed;
                        published++;
                    }
                }
            }

            s.start("Publishing...");
            const result = await fangorn.publisher.publishRecords({
                records: streamRecords(),
                schemaName: options.schema,
                datasetName: options.dataset,
                chunkSize: options.chunkSize,
                concurrency: options.concurrency,
            });
            s.stop();

            note(
                `Manifest URI: ${result.manifestUri}\n` +
                `Entries:      ${result.entryCount.toString()}\n` +
                `Schema:       ${result.schemaId}`,
                "Upload complete",
            );
            process.exit(0);
        } catch (err) {
            console.error("Failed:", (err as Error).message);
            process.exit(1);
        }
    });

publishCmd
    .command("entry")
    .description("Show details for one of your manifest entries")
    .argument("<tag>", "Entry tag / name")
    .requiredOption("-s, --schema <schemaName>", "Schema name")
    .requiredOption("-d, --dataset <datasetName>", "Dataset name")
    .action(async (tag: string, options: { schema: string; dataset: string }) => {
        try {
            const fangorn = getFangorn();
            const s = spinner();

            s.start(`Fetching entry "${tag}"...`);
            const entry = await fangorn.publisher.getEntry(options.schema, options.dataset, tag);
            s.stop();

            note(JSON.stringify(entry, null, 2), `Entry: ${tag}`);
            process.exit(0);
        } catch (err) {
            console.error("Failed:", (err as Error).message);
            process.exit(1);
        }
    });

// ─── consume ──────────────────────────────────────────────────────────────────

const consumeCmd = program
    .command("consume")
    .description("Consumer operations");

consumeCmd
    .command("list")
    .description("List a publisher's manifest entries")
    .requiredOption("-s, --schema <schemaName>", "Schema name or bytes32 ID")
    .requiredOption("--owner <address>", "Publisher address")
    .action(async (options: { schema: string; owner: Address }) => {
        try {
            const fangorn = getFangorn();
            const schemaId = await resolveSchemaId(fangorn, options.schema);
            const manifest = await fangorn.consumer.getEntry(options.owner, schemaId, options.schema);

            if (!manifest) {
                log.warn("No manifest found.");
                process.exit(0);
            }

            console.log(`Owner:   ${options.owner}`);
            console.log(`Schema:  ${options.schema}`);
            process.exit(0);
        } catch (err) {
            console.error("Failed:", (err as Error).message);
            process.exit(1);
        }
    });

consumeCmd
    .command("entry")
    .description("Show a publisher's manifest entry")
    .argument("<tag>", "Entry tag / name")
    .requiredOption("-s, --schema <schemaName>", "Schema name or bytes32 ID")
    .requiredOption("--owner <address>", "Publisher address")
    .action(async (tag: string, options: { schema: string; owner: Address }) => {
        try {
            const fangorn = getFangorn();
            const schemaId = await resolveSchemaId(fangorn, options.schema);
            const entry = await fangorn.consumer.getEntry(options.owner, schemaId, tag);
            note(JSON.stringify(entry, null, 2), `Entry: ${tag}`);
            process.exit(0);
        } catch (err) {
            console.error("Failed:", (err as Error).message);
            process.exit(1);
        }
    });

// consumeCmd
//     .command("purchase")
//     .description("Phase 1: pay and join the access group")
//     .argument("<owner>", "Publisher address")
//     .argument("<name>", "Entry name")
//     .requiredOption("-s, --schema <schemaName>", "Schema name or bytes32 ID")
//     .requiredOption("--burner-key <hex>", "Burner wallet private key (pays USDC)")
//     .requiredOption("--amount <usdc>", "USDC amount in smallest unit")
//     .requiredOption("--usdc <address>", "USDC contract address")
//     .action(async (
//         owner: Address,
//         name: string,
//         options: { schema: string; burnerKey: Hex; amount: string; usdc: Address },
//     ) => {
//         try {
//             const fangorn = getFangorn();
//             const cfg = loadConfig();
//             const schemaId = await resolveSchemaId(fangorn, options.schema);
//             const relayerKey = cfg.privateKey;
//             const s = spinner();

//             const identity = new Identity();
//             const chain = getChain(cfg.cfg.chainName);
//             const walletClient = createWalletClient({
//                 account: privateKeyToAccount(options.burnerKey),
//                 chain,
//                 transport: http(cfg.cfg.rpcUrl),
//             });

//             s.start("Preparing ERC-3009 authorization...");
//             const preparedRegister = await fangorn.consumer.prepareRegister({
//                 walletClient,
//                 paymentRecipient: owner,
//                 amount: BigInt(options.amount),
//                 usdcAddress: options.usdc,
//                 usdcDomainName: "USD Coin",
//                 usdcDomainVersion: "2",
//             });
//             s.stop();

//             s.start("Submitting registration...");
//             const { txHash } = await fangorn.consumer.register({
//                 owner,
//                 schemaId,
//                 name,
//                 identityCommitment: identity.commitment,
//                 relayerPrivateKey: relayerKey,
//                 preparedRegister,
//             });
//             s.stop();

//             const exported = identity.export();

//             note(
//                 [
//                     `Tx: ${txHash}`,
//                     ``,
//                     `⚠️  Save this identity string — you will need it for \`claim\`:`,
//                     ``,
//                     `  ${exported}`,
//                     ``,
//                     `Next:`,
//                     `  fangorn consume claim ${owner} ${name} \\`,
//                     `    -s ${options.schema} \\`,
//                     `    --identity '${exported}' \\`,
//                     `    --stealth <your-stealth-address>`,
//                 ].join("\n"),
//                 "Purchase complete ✓",
//             );
//             process.exit(0);
//         } catch (err) {
//             console.error("Failed:", (err as Error).message);
//             process.exit(1);
//         }
//     });

// consumeCmd
//     .command("claim")
//     .description("Phase 2: prove membership and claim access")
//     .argument("<owner>", "Publisher address")
//     .argument("<name>", "Entry name")
//     .requiredOption("-s, --schema <schemaName>", "Schema name or bytes32 ID")
//     .requiredOption("--identity <string>", "Exported identity from `consume purchase`")
//     .requiredOption("--stealth <address>", "Stealth address to receive the access token")
//     .action(async (
//         owner: Address,
//         name: string,
//         options: { schema: string; identity: string; stealth: Address },
//     ) => {
//         try {
//             const fangorn = getFangorn();
//             const schemaId = await resolveSchemaId(fangorn, options.schema);
//             const relayerKey = loadConfig().privateKey;
//             const identity = new Identity(options.identity);
//             const s = spinner();

//             s.start("Generating ZK proof...");
//             const preparedSettle = await fangorn.consumer.prepareSettle({
//                 resourceId: DataSourceRegistry.resourceIdLocal(owner, schemaId, name),
//                 identity,
//                 stealthAddress: options.stealth,
//             });
//             s.stop();

//             s.start("Submitting settlement...");
//             const { txHash, nullifier } = await fangorn.consumer.claim({
//                 owner,
//                 schemaId,
//                 name,
//                 relayerPrivateKey: relayerKey,
//                 preparedSettle,
//             });
//             s.stop();

//             note(
//                 [
//                     `Tx:        ${txHash}`,
//                     `Nullifier: ${nullifier.toString()}`,
//                     ``,
//                     `Next:`,
//                     `  fangorn consume fetch ${owner} ${name} \\`,
//                     `    -s ${options.schema} \\`,
//                     `    -f <field> \\`,
//                     `    --nullifier ${nullifier.toString()} \\`,
//                     `    --stealth-key <stealth-private-key> \\`,
//                     `    -o out.mp3`,
//                 ].join("\n"),
//                 "Claim complete ✓",
//             );
//             process.exit(0);
//         } catch (err) {
//             console.error("Failed:", (err as Error).message);
//             process.exit(1);
//         }
//     });

// consumeCmd
//     .command("fetch")
//     .description("Fetch a field after purchase and claim")
//     .argument("<owner>", "Publisher address")
//     .argument("<name>", "Entry name")
//     .requiredOption("-s, --schema <schemaName>", "Schema name or bytes32 ID")
//     .requiredOption("-f, --field <field>", "Field name to fetch")
//     .requiredOption("--nullifier <bigint>", "Nullifier from `consume claim`")
//     .requiredOption("--stealth-key <hex>", "Private key of the stealth address")
//     .option("-o, --output <path>", "Write output to file (default: stdout)")
//     .action(async (
//         owner: Address,
//         name: string,
//         options: {
//             schema: string;
//             field: string;
//             nullifier: string;
//             stealthKey: Hex;
//             output?: string;
//         },
//     ) => {
//         try {
//             const cfg = loadConfig();
//             const chain = getChain(cfg.cfg.chainName);
//             const fangorn = getFangorn();
//             const schemaId = await resolveSchemaId(fangorn, options.schema);
//             const s = spinner();

//             const walletClient = createWalletClient({
//                 account: privateKeyToAccount(options.stealthKey),
//                 chain,
//                 transport: http(cfg.cfg.rpcUrl),
//             });

//             s.start("Fetching...");
//             const { data } = await fangorn.consumer.fetchField(
//                 owner,
//                 schemaId,
//                 name,
//                 options.field,
//                 options.nullifier,
//                 walletClient,
//             );
//             s.stop();
        
//             if (options.output) {
//                 writeFileSync(options.output, Buffer.from(data));
//                 console.log(`Saved to: ${options.output}`);
//             } else {
//                 process.stdout.write(Buffer.from(data));
//                 process.stdout.write("\n");
//             }
//             process.exit(0);
//         } catch (err) {
//             console.error("Failed:", (err as Error).message);
//             process.exit(1);
//         }
//     });

// ─── datasource ───────────────────────────────────────────────────────────────

const datasourceCmd = program
    .command("datasource")
    .description("Data source registry queries");

datasourceCmd
    .command("info")
    .description("Show on-chain manifest info for an owner + schema")
    .requiredOption("-s, --schema <schemaName>", "Schema name or bytes32 ID")
    .option("--owner <address>", "Owner address (defaults to your wallet)")
    .action(async (options: { schema: string; owner?: Address }) => {
        try {
            const self = getAccount().address;
            const owner = options.owner ?? self;
            const fangorn = getFangorn();
            const schemaId = await resolveSchemaId(fangorn, options.schema);
            const ds = await fangorn.getDatasourceRegistry().get(owner, schemaId, options.schema);

            console.log(`Owner:        ${owner}`);
            console.log(`Schema ID:    ${schemaId}`);
            console.log(`Version:      ${String(ds.version)}`);
            console.log(`Manifest CID: ${ds.manifestCid || "(none yet)"}`);
            process.exit(0);
        } catch (err) {
            console.error("Failed:", (err as Error).message);
            process.exit(1);
        }
    });

// ─── repo (git-native data model) ───────────────────────────────────────────
//
// A dataset is a repository: a local `.fangorn/` tracks a schema-typed dataset and
// its tip commit. `commit` builds history locally (permissionless); `push` moves
// the on-chain pointer (permissioned). See docs/PROTOCOL.md §5, §7, §11.
//
// NOTE: repo creation lives under `fangorn repo init` because top-level `init`
// already configures wallet/credentials. (Naming to be reconciled later.)

const repoCmd = program.command("repo").description("Dataset repository operations");

repoCmd
    .command("init")
    .description("Create a local dataset repo in the current directory")
    .argument("<name>", "Dataset (repo) name")
    .requiredOption("-s, --schema <schemaName>", "Schema name or bytes32 ID this repo conforms to")
    .action(async (name: string, options: { schema: string }) => {
        try {
            if (LocalRepo.exists()) throw new Error("a Fangorn repo already exists here");
            const fangorn = getFangorn();
            const owner = getAccount().address;
            const schemaId = await resolveSchemaId(fangorn, options.schema);
            LocalRepo.init({ name, schema: options.schema, schemaId, owner });
            note(
                `Repo:    ${name}\nSchema:  ${options.schema}\nSchemaId:${schemaId}\nOwner:   ${owner}`,
                "Initialized empty Fangorn repo (.fangorn/)",
            );
            process.exit(0);
        } catch (err) {
            console.error("Failed:", (err as Error).message);
            process.exit(1);
        }
    });

program
    .command("clone")
    .description("Reconstruct a dataset repo from its on-chain tip + IPFS history")
    .argument("<owner>", "Owner (publisher) address of the dataset")
    .requiredOption("-s, --schema <schemaName>", "Schema name or bytes32 ID")
    .requiredOption("-d, --dataset <name>", "Dataset (repo) name")
    .option("--dir <path>", "Directory to clone into (default: ./<dataset>)")
    .action(async (owner: Address, options: { schema: string; dataset: string; dir?: string }) => {
        try {
            const fangorn = getFangorn();
            const schemaId = await resolveSchemaId(fangorn, options.schema);
            const s = spinner();

            s.start("Resolving on-chain tip...");
            const tip = await fangorn.publisher.resolveTip(owner, schemaId, options.dataset);
            if (!tip) { s.stop(); throw new Error(`no on-chain tip for ${owner}/${options.dataset} — nothing to clone`); }

            // Reconstruct history from IPFS alone — no subgraph. Walking the parent
            // chain proves the whole history is retrievable and self-verifying.
            const objects = new ObjectStore(fangorn.getStorage());
            let count = 0;
            for await (const step of objects.walkParents(tip)) { void step; count++; }
            s.stop();

            const dir = options.dir ?? join(process.cwd(), options.dataset);
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            if (LocalRepo.exists(dir)) throw new Error(`a Fangorn repo already exists at ${dir}`);
            const repo = LocalRepo.init({ name: options.dataset, schema: options.schema, schemaId, owner }, dir);
            repo.setHead(tip);

            note(
                `Into:    ${dir}\nTip:     ${tip}\nCommits: ${count.toString()} (reconstructed from IPFS)`,
                "Cloned",
            );
            process.exit(0);
        } catch (err) {
            console.error("Failed:", (err as Error).message);
            process.exit(1);
        }
    });

program
    .command("commit")
    .description("Snapshot data into a new local commit (does not push)")
    .argument("<files...>", "JSON file(s) of records to commit")
    .requiredOption("-m, --message <msg>", "Commit message")
    .option("--chunk-size <n>", "Records per chunk (default 1000)", (v) => parseInt(v, 10))
    .option("--concurrency <n>", "Parallel chunk uploads (default 10)", (v) => parseInt(v, 10))
    .action(async (files: string[], options: { message: string; chunkSize?: number; concurrency?: number }) => {
        try {
            const repo = LocalRepo.open();
            const cfg = repo.config();
            const fangorn = getFangorn();
            const head = repo.head();
            const parents = head ? [head] : [];
            const s = spinner();

            s.start(parents.length ? "Committing (building on local HEAD)..." : "Committing (initial)...");
            const result = await fangorn.publisher.commitRecords({
                records: streamRecordsFromFiles(files),
                schemaName: cfg.schema,
                datasetName: cfg.name,
                parents,
                message: options.message,
                chunkSize: options.chunkSize,
                concurrency: options.concurrency,
            });
            s.stop();

            repo.setHead(result.commitCid);
            note(
                `Commit:   ${result.commitCid}\n` +
                `Parent:   ${parents[0] ?? "(root)"}\n` +
                `Tree:     ${result.manifestCid}\n` +
                `Chunks:   ${result.entryCount.toString()} (${result.uploadedCount.toString()} uploaded, ${result.reusedCount.toString()} reused)\n` +
                `Message:  ${options.message}`,
                "Committed (local)",
            );
            process.exit(0);
        } catch (err) {
            console.error("Failed:", (err as Error).message);
            process.exit(1);
        }
    });

program
    .command("push")
    .description("Publish the local tip commit on-chain (the permissioned step)")
    .option("--force", "Push even if it does not fast-forward the on-chain tip")
    .action(async (options: { force?: boolean }) => {
        try {
            const repo = LocalRepo.open();
            const cfg = repo.config();
            const head = repo.head();
            if (!head) throw new Error("nothing to push — no commits yet");
            const fangorn = getFangorn();
            const objects = new ObjectStore(fangorn.getStorage());
            const commit = await objects.getCommit(head);
            const s = spinner();

            s.start("Pushing...");
            const { txHash, onChainTip } = await fangorn.publisher.push({
                commitCid: head,
                root: commit.root,
                schemaId: cfg.schemaId,
                datasetName: cfg.name,
                expectedParent: commit.parents[0],
                force: options.force,
            });
            s.stop();

            note(`Tx:   ${txHash}\nTip:  ${onChainTip}`, "Pushed");
            process.exit(0);
        } catch (err) {
            console.error("Failed:", (err as Error).message);
            process.exit(1);
        }
    });

program
    .command("status")
    .description("Compare the local tip with the on-chain tip")
    .action(async () => {
        try {
            const repo = LocalRepo.open();
            const cfg = repo.config();
            const localHead = repo.head();
            const fangorn = getFangorn();

            let onChainTip: string | undefined;
            try {
                onChainTip = (await fangorn.getDatasourceRegistry().get(cfg.owner, cfg.schemaId, cfg.name)).manifestCid || undefined;
            } catch { onChainTip = undefined; }

            const state = localHead === onChainTip
                ? "up to date"
                : localHead && !onChainTip
                    ? "local commits not yet pushed"
                    : localHead !== onChainTip
                        ? "local tip differs from on-chain tip"
                        : "no local commits";

            console.log(`Repo:         ${cfg.name}`);
            console.log(`Local HEAD:   ${localHead ?? "(none)"}`);
            console.log(`On-chain tip: ${onChainTip ?? "(none)"}`);
            console.log(`Status:       ${state}`);
            process.exit(0);
        } catch (err) {
            console.error("Failed:", (err as Error).message);
            process.exit(1);
        }
    });

program
    .command("log")
    .description("Walk commit history from the local tip")
    .option("-n, --max <n>", "Limit number of commits", (v) => parseInt(v, 10))
    .action(async (options: { max?: number }) => {
        try {
            const repo = LocalRepo.open();
            const head = repo.head();
            if (!head) { console.log("(no commits yet)"); process.exit(0); }
            const fangorn = getFangorn();
            const objects = new ObjectStore(fangorn.getStorage());

            for await (const { cid, commit } of objects.walkParents(head, options.max)) {
                const when = new Date(commit.timestamp).toISOString();
                console.log(`commit ${cid}`);
                console.log(`Author: ${commit.author}`);
                console.log(`Date:   ${when}`);
                console.log(`Tree:   ${commit.tree}`);
                console.log(`\n    ${commit.message}\n`);
            }
            process.exit(0);
        } catch (err) {
            console.error("Failed:", (err as Error).message);
            process.exit(1);
        }
    });

program
    .command("show")
    .description("Show a commit and what it changed vs. its parent")
    .argument("[commit]", "Commit CID (default: local HEAD)")
    .action(async (commitArg: string | undefined) => {
        try {
            const repo = LocalRepo.open();
            const target = commitArg ?? repo.head();
            if (!target) throw new Error("no commit to show — no commits yet");
            const fangorn = getFangorn();
            const objects = new ObjectStore(fangorn.getStorage());

            const commit = await objects.getCommit(target);
            const diff = await objects.diffCommit(target);

            console.log(`commit ${target}`);
            console.log(`Author:  ${commit.author}`);
            console.log(`Date:    ${new Date(commit.timestamp).toISOString()}`);
            console.log(`Parents: ${commit.parents.length ? commit.parents.join(", ") : "(root)"}`);
            console.log(`Tree:    ${commit.tree}`);
            console.log(`\n    ${commit.message}\n`);
            console.log(`Changes vs. parent:  +${diff.added.length.toString()} blob(s), -${diff.removed.length.toString()} blob(s)`);
            for (const c of diff.added) console.log(`  + ${c}`);
            for (const c of diff.removed) console.log(`  - ${c}`);
            process.exit(0);
        } catch (err) {
            console.error("Failed:", (err as Error).message);
            process.exit(1);
        }
    });

program.parse();