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
    createWalletClient,
    type Hex,
    type Address,
    http,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { extname, join } from "path";
import { homedir } from "os";
import { Identity } from "@semaphore-protocol/identity";
import "dotenv/config";

import { Fangorn } from "../fangorn.js";
import { getChain, handleCancel, selectChain } from "./index.js";
import type { SchemaDefinition } from "../roles/schema/index.js";
import type { PublishRecord } from "../roles/publisher/index.js";
import { AgentConfig } from "../types/index.js";
import { AppConfig, FangornConfig, SupportedNetworks } from "../config.js";
import { DataSourceRegistry } from "../registries/datasource-registry/index.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface StoredConfig {
    privateKey: Hex;
    chainName: string;
    pinataJwt: string;
    pinataGateway: string;
}

interface Config {
    privateKey: Hex;
    cfg: AppConfig;
    pinataJwt: string;
    pinataGateway: string;
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

    if (privateKey || pinataJwt || pinataGateway || chainName) {
        // Partial env vars — fail loudly rather than silently fall through.
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

async function getFangorn(): Promise<Fangorn> {
    if (_fangorn) return _fangorn;

    const cfg = loadConfig();
    const agentConfig: AgentConfig = { privateKey: cfg.privateKey, pinataJwt: cfg.pinataJwt };

    _fangorn = await Fangorn.create({
        privateKey: cfg.privateKey,
        storage: {
            pinata: {
                jwt: cfg.pinataJwt,
                gateway: cfg.pinataGateway,
            },
        },
        encryption: { lit: true },
        domain: "localhost",
        config: cfg.cfg,
        agentConfig,
    });
    return _fangorn;
}

/**
 * Resolves a schema name or bytes32 ID to an on-chain schemaId.
 * Accepts either a human-readable name (e.g. "fangorn.music.v1") or a
 * 0x-prefixed 32-byte hex string — the SchemaRegistry handles both.
 */
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
program.name("fangorn").description("Fangorn Network CLI").version("0.1.0");

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

        const stored: StoredConfig = {
            privateKey: privateKey as Hex,
            chainName: chainName as string,
            pinataJwt: pinataJwt as string,
            pinataGateway: pinataGateway as string,
        };

        if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
        writeFileSync(CONFIG_PATH, JSON.stringify(stored, null, 2), "utf-8");
        chmodSync(CONFIG_PATH, 0o600);

        outro(`Config saved to ${CONFIG_PATH}`);
    });

// schema
const schemaCmd = program
    .command("schema")
    .description("Schema registry operations");

schemaCmd
    .command("register")
    .description("Register an agent identity and/or a schema on-chain")
    .argument("<name>", "Schema / agent name")
    // .option("-e, --skip-erc", "Skip ERC-8004 agent registration")
    .action(async (
        name: string,
        // options: { skipErc?: boolean },
    ) => {
        try {
            intro("Chain selection");
            const chain = await selectChain();
            outro(`Selected chain: ${chain.name}`);

            const fangorn = await getFangorn();
            const datasourceAgentId = "";

            // if (!options.skipErc) {
            //     intro("ERC-8004 Agent Registration");

                // const description = (await text({ message: "Agent description:" })) as string;
                // handleCancel(description);

            //     const s = spinner();
            //     s.start("Registering agent...");
            //     const { agentId } = await fangorn.schema.registerAgent({ name, description });
            //     s.stop();

            //     datasourceAgentId = agentId;
            //     note(`Agent ID: ${agentId}`, "ERC-8004 registered");
            //     outro("Agent Registration complete.");
            // }

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

            const schemaName = name;
            // (await text({
            //     message: "Schema name (e.g. fangorn.music.v1):",
            //     placeholder: "fangorn.myapp.v1",
            //     validate: (v) => { if (!v) return "Required"; },
            // })) as string;
            handleCancel(schemaName);

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
                name: schemaName,
                definition,
                agentId: datasourceAgentId,
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
    .argument("<name>", "Schema name (e.g. fangorn.music.v1)")
    .action(async (name: string) => {
        try {
            const fangorn = await getFangorn();
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

// publish
const publishCmd = program
    .command("publish")
    .description("Publisher operations");

publishCmd
    .command("upload")
    .description("Encrypt and publish file(s) under a schema")
    .argument("<files...>", "File path(s) to upload")
    .requiredOption("-s, --schema <schemaName>", "Schema name (e.g. fangorn.music.v1) or bytes32 ID")
    .option("-p, --price <USDC>", "Resource price in USDC (smallest unit)", "0")
    .option("-o, --overwrite", "Overwrite existing entries instead of merging", false)
    .action(async (
        files: string[],
        options: { schema: string; price: string; overwrite: boolean },
    ) => {
        try {
            const fangorn = await getFangorn();
            const cfg = loadConfig();
            const price = BigInt(options.price);
            const s = spinner();

            const records: PublishRecord[] = files.flatMap((filepath) => {
                const data = readFileSync(filepath, "utf-8");
                const parsed = JSON.parse(data, (key, value: unknown) => {
                    if (key === "data") {
                        if (Array.isArray(value)) {
                            return new Uint8Array(value.map(v => Number(v)));
                        }
                        if (typeof value === "object" && value !== null) {
                            const obj = value as Record<string, unknown>;
                            return new Uint8Array(Object.values(obj).map(v => Number(v)));
                        }
                    }
                    return value;
                }) as unknown;
                return Array.isArray(parsed)
                    ? (parsed as PublishRecord[])
                    : ([parsed] as PublishRecord[]);
            });

            s.start("Encrypting and publishing...");
            const result = await fangorn.publisher.upload(
                {
                    records,
                    schemaName: options.schema,
                    gateway: cfg.pinataGateway,
                    options: { overwrite: options.overwrite },
                },
                price,
            );
            s.stop();

            note(
                `Manifest CID: ${result.manifestCid}\n` +
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

// TODO: This should query the subgraph
// publishCmd
//     .command("list")
//     .description("List your manifest entries for a schema")
//     .requiredOption("-s, --schema <schemaName>", "Schema name or bytes32 ID")
//     .action(async (options: { schema: string }) => {
//         try {
//             const fangorn = await getFangorn();
//             const schemaId = await resolveSchemaId(fangorn, options.schema);
//             const manifest = await fangorn.publisher.getManifest(schemaId, options.schema);

//             if (!manifest) {
//                 log.warn("No manifest found. Upload with `fangorn publish upload <files> -s <schema>`.");
//                 process.exit(0);
//             }

//             console.log(`Schema:  ${options.schema}`);
//             console.log(`Entries (${manifest.entries.length.toString()}):`);
//             for (const entry of manifest.entries) {
//                 console.log(`  - ${entry.name}`);
//             }
//             process.exit(0);
//         } catch (err) {
//             console.error("Failed:", (err as Error).message);
//             process.exit(1);
//         }
//     });

publishCmd
    .command("entry")
    .description("Show details for one of your manifest entries")
    .argument("<tag>", "Entry tag / name")
    .requiredOption("-s, --schema <schemaName>", "Schema name or bytes32 ID")
    .action(async (tag: string, options: { schema: string }) => {
        try {
            const fangorn = await getFangorn();
            const schemaId = await resolveSchemaId(fangorn, options.schema);
            const entry = await fangorn.publisher.getEntry(schemaId, tag);
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
            const fangorn = await getFangorn();
            const schemaId = await resolveSchemaId(fangorn, options.schema);
            const manifest = await fangorn.consumer.getManifest(options.owner, schemaId, options.schema);

            if (!manifest) {
                log.warn("No manifest found.");
                process.exit(0);
            }

            console.log(`Owner:   ${options.owner}`);
            console.log(`Schema:  ${options.schema}`);
            console.log(`Entries (${manifest.entries.length.toString()}):`);
            for (const entry of manifest.entries) {
                console.log(`  - ${entry.name}`);
            }
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
            const fangorn = await getFangorn();
            const schemaId = await resolveSchemaId(fangorn, options.schema);
            const entry = await fangorn.consumer.getEntry(options.owner, schemaId, tag);
            note(JSON.stringify(entry, null, 2), `Entry: ${tag}`);
            process.exit(0);
        } catch (err) {
            console.error("Failed:", (err as Error).message);
            process.exit(1);
        }
    });

/**
 * consume purchase
 *
 * Phase 1 — sign ERC-3009 authorization + join Semaphore group.
 * Prints the identity export string; the user must save it for `claim` + `decrypt`.
 */
consumeCmd
    .command("purchase")
    .description("Phase 1: pay and join the access group")
    .argument("<owner>", "Publisher address")
    .argument("<name>", "Entry name")
    .requiredOption("-s, --schema <schemaName>", "Schema name or bytes32 ID")
    .requiredOption("--burner-key <hex>", "Burner wallet private key (pays USDC)")
    .requiredOption("--amount <usdc>", "USDC amount in smallest unit")
    .requiredOption("--usdc <address>", "USDC contract address")
    .action(async (
        owner: Address,
        name: string,
        options: { schema: string; burnerKey: Hex; amount: string; usdc: Address },
    ) => {
        try {
            const fangorn = await getFangorn();
            const cfg = loadConfig();
            const schemaId = await resolveSchemaId(fangorn, options.schema);
            const relayerKey = cfg.privateKey;
            const s = spinner();

            const identity = new Identity();

            // Use the chain and RPC URL from the loaded config rather than hardcoding.
            const chain = getChain(cfg.cfg.chainName);
            const walletClient = createWalletClient({
                account: privateKeyToAccount(options.burnerKey),
                chain,
                transport: http(cfg.cfg.rpcUrl),
            });

            s.start("Preparing ERC-3009 authorization...");
            const preparedRegister = await fangorn.consumer.prepareRegister({
                walletClient,
                paymentRecipient: owner,
                amount: BigInt(options.amount),
                usdcAddress: options.usdc,
                usdcDomainName: "USD Coin",
                usdcDomainVersion: "2",
            });
            s.stop();

            s.start("Submitting registration...");
            const { txHash } = await fangorn.consumer.register({
                owner,
                schemaId,
                name,
                identityCommitment: identity.commitment,
                relayerPrivateKey: relayerKey,
                preparedRegister,
            });
            s.stop();

            const exported = identity.export();

            note(
                [
                    `Tx: ${txHash}`,
                    ``,
                    `⚠️  Save this identity string — you will need it for \`claim\` and \`decrypt\`:`,
                    ``,
                    `  ${exported}`,
                    ``,
                    `Next:`,
                    `  fangorn consume claim ${owner} ${name} \\`,
                    `    -s ${options.schema} \\`,
                    `    --identity '${exported}' \\`,
                    `    --stealth <your-stealth-address>`,
                ].join("\n"),
                "Purchase complete ✓",
            );
            process.exit(0);
        } catch (err) {
            console.error("Failed:", (err as Error).message);
            process.exit(1);
        }
    });

/**
 * consume claim
 *
 * Phase 2 — generate Groth16 ZK proof of group membership and fire the
 * SettlementRegistry hook. Prints the nullifier for use in `decrypt`.
 */
consumeCmd
    .command("claim")
    .description("Phase 2: prove membership and claim access")
    .argument("<owner>", "Publisher address")
    .argument("<name>", "Entry name")
    .requiredOption("-s, --schema <schemaName>", "Schema name or bytes32 ID")
    .requiredOption("--identity <string>", "Exported identity from `consume purchase`")
    .requiredOption("--stealth <address>", "Stealth address to receive the access token")
    .action(async (
        owner: Address,
        name: string,
        options: { schema: string; identity: string; stealth: Address },
    ) => {
        try {
            const fangorn = await getFangorn();
            const schemaId = await resolveSchemaId(fangorn, options.schema);
            const relayerKey = loadConfig().privateKey;
            const identity = new Identity(options.identity);
            const s = spinner();

            s.start("Generating ZK proof...");
            const preparedSettle = await fangorn.consumer.prepareSettle({
                resourceId: DataSourceRegistry.resourceIdLocal(owner, schemaId, name),
                identity,
                stealthAddress: options.stealth,
            });
            s.stop();

            s.start("Submitting settlement...");
            const { txHash, nullifier } = await fangorn.consumer.claim({
                owner,
                schemaId,
                name,
                relayerPrivateKey: relayerKey,
                preparedSettle,
            });
            s.stop();

            note(
                [
                    `Tx:        ${txHash}`,
                    `Nullifier: ${nullifier.toString()}`,
                    ``,
                    `Next:`,
                    `  fangorn consume decrypt ${owner} ${name} \\`,
                    `    -s ${options.schema} \\`,
                    `    -f <field> \\`,
                    `    --nullifier ${nullifier.toString()} \\`,
                    `    --stealth-key <stealth-private-key> \\`,
                    `    -o out.mp3`,
                ].join("\n"),
                "Claim complete ✓",
            );
            process.exit(0);
        } catch (err) {
            console.error("Failed:", (err as Error).message);
            process.exit(1);
        }
    });

/**
 * consume decrypt
 *
 * Decrypt a field after a completed purchase + claim cycle.
 * The stealth wallet is used to create the Lit auth context.
 */
consumeCmd
    .command("decrypt")
    .description("Decrypt a field after purchase and claim")
    .argument("<owner>", "Publisher address")
    .argument("<name>", "Entry name")
    .requiredOption("-s, --schema <schemaName>", "Schema name or bytes32 ID")
    .requiredOption("-f, --field <field>", "Field name to decrypt")
    .requiredOption("--nullifier <bigint>", "Nullifier from `consume claim`")
    .requiredOption("--stealth-key <hex>", "Private key of the stealth address")
    .option("--identity <string>", "Exported identity (required unless --skip-settlement-check)")
    .option("--skip-settlement-check", "Skip on-chain registration verification")
    .option("-o, --output <path>", "Write decrypted output to file (default: stdout)")
    .action(async (
        owner: Address,
        name: string,
        options: {
            schema: string;
            field: string;
            nullifier: string;
            stealthKey: Hex;
            identity?: string;
            skipSettlementCheck?: boolean;
            output?: string;
        },
    ) => {
        try {
            const cfg = loadConfig();
            const chain = getChain(cfg.cfg.chainName);
            const fangorn = await getFangorn();
            const schemaId = await resolveSchemaId(fangorn, options.schema);
            const s = spinner();

            const walletClient = createWalletClient({
                account: privateKeyToAccount(options.stealthKey),
                chain,
                transport: http(cfg.cfg.rpcUrl),
            });

            const identity = options.identity ? new Identity(options.identity) : undefined;

            s.start("Decrypting...");
            const decrypted = await fangorn.consumer.decrypt({
                owner,
                walletClient,
                schemaId,
                nullifierHash: BigInt(options.nullifier),
                name,
                field: options.field,
                identity,
                skipSettlementCheck: !!options.skipSettlementCheck,
            });
            s.stop();

            if (options.output) {
                writeFileSync(options.output, Buffer.from(decrypted));
                console.log(`Saved to: ${options.output}`);
            } else {
                process.stdout.write(Buffer.from(decrypted));
                process.stdout.write("\n");
            }
            process.exit(0);
        } catch (err) {
            console.error("Failed:", (err as Error).message);
            process.exit(1);
        }
    });

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
            const fangorn = await getFangorn();
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


program.parse();