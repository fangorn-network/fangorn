/**
 * Publish the FULL MusicBrainz datasource to Fangorn as ONE merkle commitment.
 *
 * Every node (any type) and every edge is emitted as an "entry" and streamed
 * through `publishRecords` → 1000 entries per merkle leaf → one root → ONE on-chain
 * tx. The chain sees a single commitment; IPFS holds the many leaf chunks. This is
 * the chunked/merkleized bulk path the SDK is built for (see backpressure.test.ts).
 *
 * The bundle (`fangorn.mb.creativecore.v1`) stays the SHAPE: it says which entry
 * `type`s are nodes and what edge `rel`s connect them. The build reconstructs the
 * graph from these entries and folds neighbors per root.
 *
 *   dotenvx run -f .env -- tsx src/test/publish_recordsets.ts \
 *     --input-dir /home/driemworks/fangorn/embeddings/stage_volumes \
 *     --limit 5000           # tiny end-to-end test first; drop --limit for the full 1-tx run
 *
 * Entry record shape (uniform resolver schema `fangorn.mb.entry.v1`, all strings):
 *   node: { kind:"node", id, type, rel:"", from:"", to:"", body:<JSON of node.fields> }
 *   edge: { kind:"edge", id:"", type:"", rel,  from,  to,  body:"" }
 *
 * Requires env (or ~/.fangorn/config.json): DELEGATOR_ETH_PRIVATE_KEY, PINATA_JWT,
 * PINATA_GATEWAY, CHAIN_NAME[, RPC_URL].
 */

import { readFileSync, existsSync, createReadStream } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { program } from "commander";
import { type Hex } from "viem";
import "dotenv/config";

import { Fangorn } from "../fangorn.js";
import { type AppConfig, FangornConfig, SupportedNetworks } from "../config.js";
import { type SchemaDefinition } from "../roles/schema/types.js";
import { type PublishRecord } from "../roles/publisher/types.js";

// ── config (env-first, then ~/.fangorn/config.json) ───────────────────────────
interface StoredConfig { privateKey: Hex; chainName: string; pinataJwt: string; pinataGateway: string; workerUrl: string }
interface ResolvedConfig { privateKey: Hex; cfg: AppConfig; pinataJwt: string; pinataGateway: string }
const CONFIG_PATH = join(homedir(), ".fangorn", "config.json");

function appConfigFor(chainName: string): AppConfig {
    return chainName === SupportedNetworks.ArbitrumSepolia.name ? FangornConfig.ArbitrumSepolia : FangornConfig.BaseSepolia;
}
function loadConfig(): ResolvedConfig {
    const privateKey = process.env.DELEGATOR_ETH_PRIVATE_KEY;
    const pinataJwt = process.env.PINATA_JWT;
    const pinataGateway = process.env.PINATA_GATEWAY;
    const chainName = process.env.CHAIN_NAME;
    if (privateKey ?? pinataJwt ?? pinataGateway ?? chainName) {
        const missing: string[] = [];
        if (!privateKey) missing.push("DELEGATOR_ETH_PRIVATE_KEY");
        if (!pinataJwt) missing.push("PINATA_JWT");
        if (!pinataGateway) missing.push("PINATA_GATEWAY");
        if (!chainName) missing.push("CHAIN_NAME");
        if (missing.length) throw new Error(`Incomplete env config. Missing: ${missing.join(", ")}`);
        return { privateKey: privateKey as Hex, cfg: appConfigFor(chainName ?? ""), pinataJwt: pinataJwt ?? "", pinataGateway: pinataGateway ?? "" };
    }
    if (existsSync(CONFIG_PATH)) {
        const s = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as StoredConfig;
        return { privateKey: s.privateKey, cfg: appConfigFor(s.chainName), pinataJwt: s.pinataJwt, pinataGateway: s.pinataGateway };
    }
    throw new Error("No configuration found. Run `fangorn init` or set DELEGATOR_ETH_PRIVATE_KEY, PINATA_JWT, PINATA_GATEWAY, CHAIN_NAME");
}
function makeFangorn(c: ResolvedConfig): Fangorn {
    const rpcOverride = process.env.RPC_URL ?? process.env.CHAIN_RPC_URL;
    const cfg = rpcOverride ? { ...c.cfg, rpcUrl: rpcOverride } : c.cfg;
    if (rpcOverride) console.log(`[publish] RPC override: ${rpcOverride}`);
    return Fangorn.create({
        privateKey: c.privateKey,
        storage: { pinata: { jwt: c.pinataJwt, gateway: c.pinataGateway } },
        domain: "localhost",
        config: cfg,
        agentConfig: { privateKey: c.privateKey, pinataJwt: c.pinataJwt },
    });
}

// ── schema files + data shapes ────────────────────────────────────────────────
interface BundleSchemaFile { name: string; kind: "bundle"; bundle: { nodes: Record<string, string>; edges: unknown[] } }
interface ConsolidatedSchemas { bundle: BundleSchemaFile }
interface MbNode { name: string; fields: Record<string, unknown> }
interface MbEdge { rel: string; from: string; to: string }

const TYPE_FILE: Record<string, string> = {
    Artist: "artists", Recording: "recordings", ReleaseGroup: "releasegroups",
    Release: "releases", Work: "works",
};

// One uniform resolver schema so every node/edge entry is a leaf in a single tree.
const ENTRY_SCHEMA: SchemaDefinition = {
    kind: { "@type": "string" }, id: { "@type": "string" }, type: { "@type": "string" },
    rel: { "@type": "string" }, from: { "@type": "string" }, to: { "@type": "string" },
    body: { "@type": "string" },
};

async function* streamJsonArray<T>(path: string, limit = 0): AsyncIterable<T> {
    const rl = createInterface({ input: createReadStream(path, { highWaterMark: 1 << 20 }), crlfDelay: Infinity });
    let n = 0;
    for await (const line of rl) {
        const s = line.trim();
        if (!s || s === "[" || s === "]") continue;
        const j = s.endsWith(",") ? s.slice(0, -1) : s;
        if (!j) continue;
        try { yield JSON.parse(j) as T; } catch { continue; }
        if (limit && ++n >= limit) { rl.close(); return; }
    }
}

async function withRetry<T>(label: string, maxAttempts: number, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try { return await fn(); }
        catch (err) {
            if (attempt === maxAttempts) throw err;
            const delay = Math.min(60_000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 1000);
            console.warn(`  [retry] ${label} (attempt ${attempt.toString()}/${maxAttempts.toString()}) in ${(delay / 1000).toFixed(1)}s: ${(err as Error).message}`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw new Error("unreachable");
}

const ZERO = `0x${"0".repeat(64)}`;
async function ensureSchema(fangorn: Fangorn, name: string, definition: SchemaDefinition, skipRegister: boolean): Promise<Hex> {
    let existing: Hex | null = null;
    try { const id = await fangorn.getSchemaRegistry().schemaId(name); existing = id.toLowerCase() === ZERO ? null : id; } catch { /* not found */ }
    if (existing) { console.log(`[publish] schema "${name}" already registered → ${existing}`); return existing; }
    if (skipRegister) throw new Error(`--skip-register but "${name}" is not registered`);
    const { schemaId } = await fangorn.schema.register({ name, definition });
    console.log(`[publish] registered "${name}" → ${schemaId}`);
    return schemaId;
}

// ── CLI ───────────────────────────────────────────────────────────────────────
program
    .option("--input-dir <path>", "Directory with volume_<n>_*.json + schemas/", "./stage_volumes")
    .option("--schemas-dir <path>", "Schema definitions dir (default <input-dir>/schemas)")
    .option("--volume <n>", "Volume number", "1")
    .option("--types <list>", "Node types to include as entries", "Recording,Artist,Work,Release,ReleaseGroup")
    .option("--no-edges", "Skip edge entries")
    .option("--entry-schema <name>", "Uniform entry schema name", "fangorn.mb.entry.v1")
    .option("--dataset <name>", "Dataset name (one manifest = one tx)", "ds.creativecore.full.v1")
    .option("--limit <n>", "Max entries per file (0 = all) — use a small value to test", "0")
    .option("--chunk-size <n>", "Entries per merkle leaf", "1000")
    .option("--concurrency <n>", "Parallel chunk uploads (low on a modest uplink)", "4")
    .option("--max-retries <n>", "Retry attempts on transient errors", "8")
    .option("--skip-register", "Don't register the entry schema; resolve existing id only", false)
    .parse();

const opts = program.opts<{
    inputDir: string; schemasDir?: string; volume: string; types: string; edges: boolean;
    entrySchema: string; dataset: string; limit: string; chunkSize: string;
    concurrency: string; maxRetries: string; skipRegister: boolean;
}>();

async function main(): Promise<void> {
    const fangorn = makeFangorn(loadConfig());
    const inputDir = resolve(opts.inputDir);
    const schemasDir = resolve(opts.schemasDir ?? join(inputDir, "schemas"));
    const volume = parseInt(opts.volume, 10);
    const limit = parseInt(opts.limit, 10) || 0;
    const chunkSize = Math.max(1, parseInt(opts.chunkSize, 10) || 1000);
    const concurrency = Math.max(1, parseInt(opts.concurrency, 10) || 4);
    const maxRetries = Math.max(1, parseInt(opts.maxRetries, 10) || 8);

    const consolidatedPath = join(schemasDir, "fangorn_schemas.json");
    if (!existsSync(consolidatedPath)) throw new Error(`Not found: ${consolidatedPath} — run \`quickbeam data schemagen\` first.`);
    const { bundle } = JSON.parse(readFileSync(consolidatedPath, "utf8")) as ConsolidatedSchemas;

    const types = opts.types.split(",").map(t => t.trim()).filter(t => t in bundle.bundle.nodes);
    const nodeFiles = types
        .map(type => ({ type, path: join(inputDir, `volume_${volume.toString()}_${TYPE_FILE[type] ?? type.toLowerCase()}.json`) }))
        .filter(f => { const ok = existsSync(f.path); if (!ok) console.warn(`   ⚠️  missing ${f.path} — skipping ${f.type}`); return ok; });
    const edgesPath = join(inputDir, `volume_${volume.toString()}_edges.json`);
    if (opts.edges && !existsSync(edgesPath)) throw new Error(`Not found: ${edgesPath}`);

    const schemaId = await ensureSchema(fangorn, opts.entrySchema, ENTRY_SCHEMA, opts.skipRegister);

    console.log(`[publish] streaming the full datasource as ONE record-set → ${opts.dataset}`);
    console.log(`[publish]   node types: ${nodeFiles.map(f => f.type).join(", ")}${opts.edges ? " + edges" : ""}${limit ? `  (limit ${limit.toLocaleString()}/file)` : ""}`);
    console.log(`[publish]   ${chunkSize.toString()} entries per leaf → one merkle root → one tx`);

    // Counters are populated as the (re-runnable) generator is consumed; withRetry
    // re-creates the generator on a transient failure, re-opening every file.
    let nodeCount = 0, edgeCount = 0;
    const entries = (): AsyncIterable<PublishRecord> => (async function* () {
        nodeCount = 0; edgeCount = 0;
        for (const { type, path } of nodeFiles) {
            for await (const node of streamJsonArray<MbNode>(path, limit)) {
                nodeCount++;
                if (nodeCount % 250_000 === 0) process.stdout.write(`\r   ${nodeCount.toLocaleString()} nodes, ${edgeCount.toLocaleString()} edges...   `);
                yield {
                    name: node.name,
                    fields: { kind: "node", id: node.name, type, rel: "", from: "", to: "", body: JSON.stringify(node.fields) },
                };
            }
        }
        if (opts.edges) {
            for await (const e of streamJsonArray<MbEdge>(edgesPath, limit)) {
                if (!(e.rel && e.from && e.to)) continue;
                edgeCount++;
                if (edgeCount % 1_000_000 === 0) process.stdout.write(`\r   ${nodeCount.toLocaleString()} nodes, ${edgeCount.toLocaleString()} edges...   `);
                yield {
                    name: `edge:${edgeCount.toString()}`,
                    fields: { kind: "edge", id: "", type: "", rel: e.rel, from: e.from, to: e.to, body: "" },
                };
            }
        }
        process.stdout.write("\n");
    })();

    const r = await withRetry("publish full datasource", maxRetries,
        () => fangorn.publisher.publishRecords({ records: entries(), schemaName: opts.entrySchema, datasetName: opts.dataset, chunkSize, concurrency }));

    console.log(`\n✅ Committed the full datasource in ONE tx.\n`);
    console.log(`  entry schema : ${opts.entrySchema}`);
    console.log(`  schema id    : ${schemaId}`);
    console.log(`  dataset      : ${opts.dataset}`);
    console.log(`  entries      : ${(nodeCount + edgeCount).toLocaleString()}  (${nodeCount.toLocaleString()} nodes, ${edgeCount.toLocaleString()} edges)`);
    console.log(`  leaves       : ${r.entryCount.toString()}`);
    console.log(`  manifest cid : ${r.manifestUri}`);
    console.log(`  bundle shape : ${bundle.name}`);
}

main().catch((err: unknown) => { console.error("\n[publish] failed:", err); process.exit(1); });
