/**
 * Build & deploy the MusicBrainz "creative core" knowledge graph to Fangorn.
 * 
 *  dotenvx run -f .env -- tsx src/test/publish_creativecore.ts \
 *   --input-dir /home/driemworks/fangorn/embeddings/stage_volumes \
 *   --root-type Recording  \
 *   --index-dir /home/driemworks/stage_volumes/cache \
 *   --sort-mem 256M
 *
 *
 * This is the §5/§6 step of docs/REBUILD_FROM_ZERO.md made executable. It:
 *   1. Ensures the root type's resolver schema is registered (idempotent; skips
 *      the IPFS re-upload if it already exists on-chain).
 *   2. DENORMALIZES the graph: each root (e.g. each Recording) + its outgoing
 *      neighbors becomes ONE record (neighbor labels folded into `text`), then
 *      publishes them with `publishRecords` — which chunks records into ~chunkSize
 *      merkle leaves and commits ONE on-chain tx per shard. Consumable by
 *      `quickbeam build --schema <name>=<id> --primary <name>`.
 *
 * ─── WHY DENORMALIZE TO A RECORD-SET ──────────────────────────────────────────
 * The bundle path (`publishBundle`) holds nodes/edges in memory, validates edges
 * O(nodes×edges), and emits one chunk per type — so it forced tiny self-contained
 * batches, i.e. ~one on-chain tx per 1000 roots (tens of thousands of txs). That
 * throws away the merkle design. `publishRecords` already does the right thing:
 * stream records → ~1000-record leaves → one tree → one tx. So we flatten each
 * root's neighborhood into a single record and publish a record-set. A handful of
 * large shards (≈ records-per-tx each) covers the whole corpus.
 *
 * The root↔neighbor join is built with SEQUENTIAL I/O only — an earlier LMDB index
 * collapsed under tens of millions of random-UUID inserts. We project root-origin
 * edges to a flat TSV, sort it (and the root file) with GNU `sort` (external merge
 * sort), then stream a merge-join. Only the bounded set of neighbor FIELDS is held
 * in memory. Needs a work dir on real disk with ~2x the data size free.
 *
 * ─── SETUP ────────────────────────────────────────────────────────────────────
 * Place this in the fangorn-sdk repo at src/test/publish_creativecore.ts (next to
 * publish_mb_bundle.ts) so its imports resolve. Run from the sdk root:
 *
 *   pnpm dotenvx run -f .env -- tsx src/test/publish_creativecore.ts \
 *     --input-dir /path/to/embeddings/stage_volumes \
 *     --root-type Recording \
 *     --index-dir /path/to/real/disk/tmp
 *
 * Requires env (or ~/.fangorn/config.json, same as the `fangorn` CLI):
 *   DELEGATOR_ETH_PRIVATE_KEY, PINATA_JWT, PINATA_GATEWAY, CHAIN_NAME[, WORKER_URL]
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
    readFileSync, writeFileSync, mkdirSync, existsSync,
    createReadStream, createWriteStream, mkdtempSync, rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { homedir, cpus } from "node:os";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { program } from "commander";
import { type Hex } from "viem";
import "dotenv/config";

import { Fangorn } from "../fangorn.js";
import { type AppConfig, FangornConfig, SupportedNetworks } from "../config.js";
import { type BundleInput, type SchemaDefinition } from "../roles/schema/types.js";
import { type FieldInput, type PublishRecord } from "../roles/publisher/types.js";

// ── config (env-first, then ~/.fangorn/config.json — mirrors src/cli/cli.ts) ──
interface StoredConfig {
    privateKey: Hex;
    chainName: string;
    pinataJwt: string;
    pinataGateway: string;
    workerUrl: string;
}
interface ResolvedConfig {
    privateKey: Hex;
    cfg: AppConfig;
    pinataJwt: string;
    pinataGateway: string;
}

const CONFIG_PATH = join(homedir(), ".fangorn", "config.json");

function appConfigFor(chainName: string): AppConfig {
    return chainName === SupportedNetworks.ArbitrumSepolia.name
        ? FangornConfig.ArbitrumSepolia
        : FangornConfig.BaseSepolia;
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
        return {
            privateKey: privateKey as Hex,
            cfg: appConfigFor(chainName ?? ""),
            pinataJwt: pinataJwt ?? "",
            pinataGateway: pinataGateway ?? "",
        };
    }

    if (existsSync(CONFIG_PATH)) {
        const s = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as StoredConfig;
        return { privateKey: s.privateKey, cfg: appConfigFor(s.chainName), pinataJwt: s.pinataJwt, pinataGateway: s.pinataGateway };
    }

    throw new Error(
        "No configuration found. Run `fangorn init` or set env vars:\n" +
        "  DELEGATOR_ETH_PRIVATE_KEY, PINATA_JWT, PINATA_GATEWAY, CHAIN_NAME",
    );
}

function makeFangorn(c: ResolvedConfig): Fangorn {
    // The default chain config points at the public Arbitrum/Base Sepolia RPC,
    // which rate-limits (429) under a long publish run. Allow overriding it with a
    // dedicated endpoint (Alchemy/Infura/etc.) via RPC_URL / CHAIN_RPC_URL.
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

// ── schema-definition file shapes (what schemagen writes) ─────────────────────
interface NodeSchemaFile { name: string; definition: SchemaDefinition }
interface BundleSchemaFile { name: string; kind: "bundle"; bundle: BundleInput }
interface ConsolidatedSchemas { schemas: NodeSchemaFile[]; bundle: BundleSchemaFile }

// ── data file shapes (what the pipelines write) ───────────────────────────────
interface MbNode { name: string; fields: Record<string, unknown> }
interface MbEdge { rel: string; from: string; to: string; fromType?: string; toType?: string }
interface IndexedNode { type: string; fields: Record<string, unknown> }

// type name → volume_<n>_<stem>.json stem
const TYPE_FILE: Record<string, string> = {
    Artist: "artists", Recording: "recordings", ReleaseGroup: "releasegroups",
    Release: "releases", Work: "works", Track: "tracks", Taxonomy: "taxonomies",
};

/**
 * Stream the elements of a JSON-array file one at a time. The pipelines write one
 * record per line (`[\n {..},\n {..}\n]`), so a line reader + native JSON.parse is
 * dramatically faster than a streaming JSON tokenizer over tens of GB. Brackets,
 * blank lines and the trailing comma are stripped per line.
 */
async function* streamJsonArray<T>(path: string): AsyncIterable<T> {
    const rl = createInterface({
        input: createReadStream(path, { highWaterMark: 1 << 20 }),
        crlfDelay: Infinity,
    });
    for await (const line of rl) {
        const s = line.trim();
        if (!s || s === "[" || s === "]") continue;
        const j = s.endsWith(",") ? s.slice(0, -1) : s;
        if (!j) continue;
        try { yield JSON.parse(j) as T; } catch { /* skip a malformed line */ }
    }
}

function human(n: number): string {
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
    return n.toString();
}
function hms(ms: number): string {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h.toString()}h${m.toString().padStart(2, "0")}m` : `${m.toString()}m${sec.toString().padStart(2, "0")}s`;
}

/**
 * In-place progress line with both a smoothed-instantaneous rate (last tick) and
 * a cumulative average, plus elapsed time and an optional ETA when a total is known.
 */
class Progress {
    private readonly start = Date.now();
    private last = 0;
    private lastT = Date.now();
    constructor(private readonly label: string, private readonly total = 0) {}
    tick(n: number, extra = ""): void {
        const now = Date.now();
        const inst = (n - this.last) / Math.max((now - this.lastT) / 1000, 0.001);
        const avg = n / Math.max((now - this.start) / 1000, 0.001);
        this.last = n; this.lastT = now;
        const eta = this.total && avg > 0 ? ` | eta ${hms(((this.total - n) / avg) * 1000)}` : "";
        process.stdout.write(
            `\r   ${this.label.padEnd(14)} ${human(n).padStart(7)}${extra} | ${human(Math.round(inst)).padStart(6)}/s now, ` +
            `${human(Math.round(avg)).padStart(6)}/s avg | ${hms(now - this.start)}${eta}      `,
        );
    }
    done(n: number, extra = ""): void { this.tick(n, extra); process.stdout.write("\n"); }
}

/** Read a tab-separated file line by line, yielding the split columns. */
async function* streamTsv(path: string): AsyncIterable<string[]> {
    const rl = createInterface({ input: createReadStream(path, { highWaterMark: 1 << 20 }), crlfDelay: Infinity });
    for await (const line of rl) {
        if (line) yield line.split("\t");
    }
}

/**
 * Run GNU `sort` as an external merge sort (disk-backed, parallel) to order tens
 * of GB without random I/O. LC_ALL=C gives byte ordering, matching JS string `<`
 * on the ASCII MBID keys we merge on. `keyArgs` selects the sort key (empty =
 * whole line). Writes `output`, spilling to `tmpDir`.
 */
function runSort(input: string, output: string, keyArgs: string[], tmpDir: string, mem: string, parallel: number): Promise<void> {
    return new Promise((res, rej) => {
        const args = [...keyArgs, "-S", mem, "--parallel=" + parallel.toString(), "-T", tmpDir, "-o", output, input];
        const t0 = Date.now();
        const p = spawn("sort", args, { env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "ignore", "inherit"] });
        p.on("error", rej);
        p.on("close", (code) => {
            if (code === 0) { console.log("   sorted " + (input.split("/").pop() ?? input) + " in " + hms(Date.now() - t0)); res(); }
            else rej(new Error("sort exited " + (code === null ? "null" : code.toString()) + " for " + input));
        });
    });
}

// ── schema conformance ────────────────────────────────────────────────────────
// schemagen infers schemas from a sample, so the full corpus has records that are
// missing "required" fields or have a different type than inferred (e.g. isrcCodes
// declared `string` but stored as an array). The SDK's validateRecord is strict:
// every schema field must be present and scalar types must match exactly. We coerce
// each record to its schema so a single odd record can't abort a whole batch.

function defaultFor(baseType: string): FieldInput {
    switch (baseType) {
        case "number": return 0;
        case "boolean": return false;
        case "array": return [];
        case "object": return {};
        case "bytes": return new Uint8Array();
        default: return ""; // string + anything unknown
    }
}

function coerce(value: unknown, baseType: string, nullable: boolean): FieldInput {
    if (value === undefined || value === null) return nullable ? null : defaultFor(baseType);
    switch (baseType) {
        case "string":
            if (typeof value === "string") return value;
            if (typeof value === "number" || typeof value === "boolean") return String(value);
            return JSON.stringify(value); // array/object → string
        case "number":
            if (typeof value === "number") return value;
            if (typeof value === "string" && value.trim() !== "") { const n = Number(value); if (Number.isFinite(n)) return n; }
            return nullable ? null : 0;
        case "boolean":
            if (typeof value === "boolean") return value;
            if (typeof value === "string") return value === "true";
            return Boolean(value);
        case "array":  return Array.isArray(value) ? (value as FieldInput) : (nullable ? null : []);
        case "object": return (typeof value === "object" ? (value as FieldInput) : (nullable ? null : {}));
        default:       return value as FieldInput; // bytes / unknown — pass through
    }
}

/** Produce exactly the schema's fields, coerced to satisfy the SDK validator. */
function conformFields(raw: Record<string, unknown>, def: SchemaDefinition): Record<string, FieldInput> {
    const out: Record<string, FieldInput> = {};
    for (const [name, fd] of Object.entries(def)) {
        const rawType = String(fd["@type"]);
        const nullable = rawType.includes("| null");
        out[name] = coerce(raw[name], rawType.replace("| null", "").trim(), nullable);
    }
    return out;
}

/** Mirror of the SDK's validateField — used as a final net to skip the unsalvageable. */
function recordErrors(fields: Record<string, FieldInput>, def: SchemaDefinition): string[] {
    const errors: string[] = [];
    for (const [name, fd] of Object.entries(def)) {
        const rawType = String(fd["@type"]);
        const nullable = rawType.includes("| null");
        const baseType = rawType.replace("| null", "").trim();
        const v = fields[name];
        if (v === null || v === undefined) { if (!nullable) errors.push(`"${name}" is required`); continue; }
        if (baseType === "string" && typeof v !== "string") errors.push(`${name} must be string`);
        else if (baseType === "number" && typeof v !== "number") errors.push(`${name} must be number`);
        else if (baseType === "boolean" && typeof v !== "boolean") errors.push(`${name} must be boolean`);
    }
    return errors;
}

/**
 * Transient = worth retrying (network/storage/RPC hiccups): HTTP 408/425/429/5xx,
 * socket resets/timeouts, RPC rate-limits. viem wraps the real cause several layers
 * deep (the top-level ContractFunctionExecutionError has no statusCode and a "HTTP
 * request failed" message), so we walk the whole `cause` chain and scan status
 * codes + message/details/metaMessages. A schema-validation error is deterministic,
 * so we fail fast on those instead of burning the retry budget.
 */
function isTransient(err: unknown): boolean {
    let cur: unknown = err;
    let transient = false, deterministic = false;
    for (let depth = 0; cur && depth < 8; depth++) {
        const o = cur as Record<string, unknown>;
        const status = Number((o.status ?? o.statusCode ?? 0) as number);
        if (status === 408 || status === 425 || status === 429 || status >= 500) transient = true;
        const meta = Array.isArray(o.metaMessages) ? o.metaMessages.join(" ") : "";
        const text = `${String(o.code ?? "")} ${String(o.shortMessage ?? "")} ${String(o.details ?? "")} ${String(o.message ?? "")} ${meta}`;
        if (/Validation failed|undeclared|unknown node|exceeds max|is required|must be (?:string|number|boolean)/i.test(text)) deterministic = true;
        if (/\b429\b|too many requests|rate.?limit|\b50[234]\b|HTTP_ERROR|HTTP request failed|ECONN|ETIMEDOUT|EAI_AGAIN|disconnected|timed? ?out|socket hang up|network|fetch failed|terminated|nonce/i.test(text)) transient = true;
        cur = o.cause;
    }
    return deterministic ? false : transient;
}

async function withRetry<T>(label: string, maxAttempts: number, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try { return await fn(); }
        catch (err) {
            if (attempt === maxAttempts || !isTransient(err)) throw err;
            // Exponential backoff (cap 60s) + jitter, so a flaky/overloaded Pinata
            // gets progressively more breathing room instead of a tight 5×20s burst.
            const delayMs = Math.min(60_000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 1000);
            console.warn(`  [retry] ${label} failed (attempt ${attempt.toString()}/${maxAttempts.toString()}), retrying in ${(delayMs / 1000).toFixed(1)}s: ${(err as Error).message}`);
            await new Promise(r => setTimeout(r, delayMs));
        }
    }
    throw new Error("unreachable");
}

// ── ledger (resumable) ────────────────────────────────────────────────────────
interface ShardEntry { shardIndex: number; dataset: string; manifestUri: string; rootCount: number; recordCount: number; publishedAt: string }
interface Ledger { schemaName: string; schemaId: Hex; rootType: string; shards: ShardEntry[] }

function loadLedger(path: string): Ledger | null {
    if (!existsSync(path)) return null;
    try {
        const l = JSON.parse(readFileSync(path, "utf8")) as Ledger;
        // Ignore an incompatible (old bundle-era) ledger that lacks `shards`.
        return Array.isArray(l.shards) ? l : null;
    } catch { return null; }
}
function saveLedger(path: string, ledger: Ledger): void {
    mkdirSync("tmp", { recursive: true });
    writeFileSync(path, JSON.stringify(ledger, null, 2));
}

// ── CLI ─────────────────────────────────────────────────────────────────────
program
    .option("--input-dir <path>", "Directory with volume_<n>_*.json + schemas/", "./stage_volumes")
    .option("--schemas-dir <path>", "Schema definitions dir (default <input-dir>/schemas)")
    .option("--volume <n>", "Volume number", "1")
    .option("--root-type <type>", "Node type that becomes one batch unit / one embedded record", "Recording")
    .option("--dataset <name>", "Base dataset name", "ds.creativecore.records.v1")
    .option("--records-per-tx <n>", "Records per publishRecords call = one merkle tree = one on-chain tx (buffered in RAM; raise for fewer txs if you have RAM)", "500000")
    .option("--chunk-size <n>", "Records per merkle leaf (chunk)", "1000")
    .option("--bundle-name <name>", "Override bundle name (default: from fangorn_schemas.json)")
    .option("--bundle-schema-id <hex>", "Reuse an existing bundle schema id and skip registration")
    .option("--skip-register", "Skip schema/bundle registration; only publish data", false)
    .option("--ledger <path>", "Ledger file path (default: tmp/creativecore-<dataset>.json)")
    .option("--index-dir <path>", "Temp work dir for sort spill + intermediates — MUST be on real disk with ~2x the data size free", "tmp")
    .option("--sort-mem <size>", "Memory buffer for GNU sort, e.g. 256M, 1G (small = safe on low-RAM laptops; spills to disk)", "256M")
    .option("--sort-parallel <n>", "Threads per GNU sort (default: CPU count)", "")
    .option("--max-retries <n>", "Retry attempts per batch on transient (network) errors", "10")
    .option("--batch-delay <ms>", "Delay between batches (ms) to ease RPC rate limits", "0")
    .option("--concurrency <n>", "Parallel chunk uploads (keep low on a modest uplink to avoid Pinata 408s)", "4")
    .parse();

const opts = program.opts<{
    inputDir: string; schemasDir?: string; volume: string; rootType: string;
    dataset: string; recordsPerTx: string; chunkSize: string; bundleName?: string; bundleSchemaId?: string;
    skipRegister: boolean; ledger?: string; indexDir: string; sortMem: string; sortParallel: string;
    maxRetries: string; batchDelay: string; concurrency: string;
}>();

async function main(): Promise<void> {
    const config = loadConfig();
    const fangorn = makeFangorn(config);

    const inputDir = resolve(opts.inputDir);
    const schemasDir = resolve(opts.schemasDir ?? join(inputDir, "schemas"));
    const volume = parseInt(opts.volume, 10);
    const rootType = opts.rootType;
    const recordsPerTx = Math.max(1, parseInt(opts.recordsPerTx, 10) || 1_000_000);
    const chunkSize = Math.max(1, parseInt(opts.chunkSize, 10) || 1000);
    const maxRetries = parseInt(opts.maxRetries, 10);
    const batchDelay = parseInt(opts.batchDelay, 10) || 0;
    const concurrency = parseInt(opts.concurrency, 10);

    const consolidatedPath = join(schemasDir, "fangorn_schemas.json");
    if (!existsSync(consolidatedPath)) throw new Error(`Not found: ${consolidatedPath} — run \`quickbeam data schemagen\` first.`);
    const { schemas, bundle } = JSON.parse(readFileSync(consolidatedPath, "utf8")) as ConsolidatedSchemas;
    const bundleName = opts.bundleName ?? bundle.name;

    if (!(rootType in bundle.bundle.nodes)) {
        throw new Error(`--root-type "${rootType}" is not a node type in the bundle (have: ${Object.keys(bundle.bundle.nodes).join(", ")})`);
    }
    const rootStem = TYPE_FILE[rootType] ?? rootType.toLowerCase();
    const rootPath = join(inputDir, `volume_${volume.toString()}_${rootStem}.json`);
    const edgesPath = join(inputDir, `volume_${volume.toString()}_edges.json`);
    for (const p of [rootPath, edgesPath]) if (!existsSync(p)) throw new Error(`Not found: ${p}`);

    // ── 1. Resolve the record-set schema (one resolver schema, not a bundle) ──
    // Denormalized records are published under a SINGLE resolver schema (the root
    // type's schema, e.g. fangorn.mb.recording.v1). publishRecords chunks them into
    // merkle leaves → one tree → one on-chain tx per shard.
    const schemaName = bundle.bundle.nodes[rootType];
    let schemaId: Hex;
    {
        const ZERO = `0x${"0".repeat(64)}`;
        const reg = fangorn.getSchemaRegistry();
        let existing: Hex | null = null;
        try { const id = await reg.schemaId(schemaName); existing = id.toLowerCase() === ZERO ? null : id; } catch { existing = null; }
        if (opts.bundleSchemaId) {
            schemaId = opts.bundleSchemaId as Hex;
            console.log(`[publish] reusing schema id: ${schemaId}`);
        } else if (existing) {
            schemaId = existing;
            console.log(`[publish] schema "${schemaName}" already registered → ${schemaId}`);
        } else if (opts.skipRegister) {
            throw new Error(`--skip-register but schema "${schemaName}" is not registered`);
        } else {
            const localDef = schemas.find(s => s.name === schemaName)?.definition;
            if (!localDef) throw new Error(`No local definition for "${schemaName}" in ${consolidatedPath}`);
            ({ schemaId } = await fangorn.schema.register({ name: schemaName, definition: localDef }));
            console.log(`[publish] registered schema "${schemaName}" → ${schemaId}`);
        }
    }

    // The definition publishRecords validates against — prefer the on-chain
    // (registered) one, fall back to the local schemagen file.
    const regSchema = await fangorn.schema.get(schemaName);
    const recordingDef: SchemaDefinition =
        (regSchema && regSchema.kind === "resolver" ? regSchema.definition : undefined)
        ?? schemas.find(s => s.name === schemaName)?.definition
        ?? {};
    if (Object.keys(recordingDef).length === 0) throw new Error(`No definition available for "${schemaName}"`);

    // Declared (rel, fromType, toType) triples — skip any edge not in the shape
    // so one stray edge never fails an entire batch's validation.
    const declaredEdges = new Set(bundle.bundle.edges.map(e => `${e.rel}:${e.from}:${e.to}`));

    const ledgerPath = opts.ledger ?? `tmp/creativecore-${opts.dataset.replace(/[^a-z0-9._-]/gi, "_")}.json`;

    // ── 2. Sort-merge build (sequential I/O only — no random-key index) ───────
    // LMDB choked on tens of millions of random-UUID inserts. Instead we project
    // the data to flat files, sort them with GNU `sort` (external merge sort), and
    // stream a merge-join — all sequential I/O. Only the bounded set of neighbor
    // FIELDS is held in memory.
    const workBase = resolve(opts.indexDir);
    mkdirSync(workBase, { recursive: true });
    const workDir = mkdtempSync(join(workBase, "creativecore-work-"));
    console.log(`[publish] work dir (temp, on real disk — needs ~2x the data size free): ${workDir}`);
    const edgesTsv = join(workDir, "edges.tsv");
    const edgesSorted = join(workDir, "edges.sorted.tsv");
    const rootsSorted = join(workDir, "roots.sorted.jsonl");
    const sortMem = opts.sortMem;
    const sortPar = parseInt(opts.sortParallel, 10) || cpus().length;

    try {
        // Types that can be NEIGHBORS of a root — the `to` of any declared edge
        // whose `from` is the root type. For root=Recording: Artist, Work, Recording.
        const neighborTypes = new Set<string>();
        for (const e of bundle.bundle.edges) if (e.from === rootType) neighborTypes.add(e.to);

        // ── Pass 1/4: project root-origin declared edges to a flat TSV ────────
        // Sequential append only. Also collect the neighbor ids we must resolve.
        console.log(`[publish] pass 1/4: extracting ${rootType}-origin edges → edges.tsv`);
        const neededIds = new Set<string>();
        {
            const out = createWriteStream(edgesTsv);
            let scanned = 0, kept = 0;
            const eprog = new Progress("edges");
            for await (const e of streamJsonArray<MbEdge>(edgesPath)) {
                if (++scanned % 1_000_000 === 0) eprog.tick(scanned, ` | ${human(kept)} kept`);
                if (!(e.from && e.to && e.fromType === rootType)) continue;
                if (!declaredEdges.has(`${e.rel}:${e.fromType}:${e.toType ?? ""}`)) continue;
                neededIds.add(e.to);
                kept++;
                // rel never contains a tab/newline (link_type names); from/to are MBIDs.
                if (!out.write(`${e.from}\t${e.rel}\t${e.to}\n`)) await once(out, "drain");
            }
            await new Promise<void>((reso, reje) => { out.end((err?: Error | null) => { if (err) reje(err); else reso(); }); });
            eprog.done(scanned, ` | ${human(kept)} kept`);
            console.log(`[publish] kept ${kept.toLocaleString()} edges; ${neededIds.size.toLocaleString()} distinct neighbors needed`);
        }

        // ── Pass 2/4: external sort (disk-backed merge sort) ──────────────────
        // edges by `from` (col 1); roots by id — root JSON lines share an identical
        // `  {"name": "` prefix, so a byte-order line sort == sort by id. Bracket
        // lines ("[","]") sort to the end and are skipped by the JSON reader.
        console.log(`[publish] pass 2/4: external sort (mem=${sortMem}, parallel=${sortPar.toString()})...`);
        await runSort(edgesTsv, edgesSorted, ["-t", "\t", "-k", "1,1"], workDir, sortMem, sortPar);
        await runSort(rootPath, rootsSorted, [], workDir, sortMem, sortPar);

        // ── Pass 3/4: load needed neighbor LABELS into memory ─────────────────
        // Only a short label per neighbor (sortName/title/name) is kept — the full
        // fields are never needed (we just fold a label into the root's `text`), so
        // storing labels instead of whole records keeps this ~3-4x smaller. We also
        // MOVE ids out of neededIds as we resolve them, so peak RAM ≈ one map, not
        // both. This keeps the whole run within a small-laptop memory budget.
        console.log(`[publish] pass 3/4: loading needed neighbor labels from: ${[...neighborTypes].join(", ")}`);
        const neighborLabels = new Map<string, string>();
        for (const type of neighborTypes) {
            const stem = TYPE_FILE[type] ?? type.toLowerCase();
            const path = join(inputDir, `volume_${volume.toString()}_${stem}.json`);
            if (!existsSync(path)) { console.warn(`   ⚠️  missing ${path} — neighbors of type ${type} skipped`); continue; }
            let scannedNodes = 0;
            const nprog = new Progress(type);
            for await (const node of streamJsonArray<MbNode>(path)) {
                if (++scannedNodes % 1_000_000 === 0) nprog.tick(scannedNodes, ` | ${human(neighborLabels.size)} loaded`);
                if (neededIds.delete(node.name)) {
                    const f = node.fields as Record<string, unknown>;
                    const label = (f.sortName ?? f.title ?? f.name ?? "") as string;
                    if (label) neighborLabels.set(node.name, label);
                }
            }
            nprog.done(scannedNodes, ` | ${human(neighborLabels.size)} loaded`);
        }
        neededIds.clear();
        console.log(`[publish] ${neighborLabels.size.toLocaleString()} neighbor labels in memory`);

        // ── Pass 4/4: merge-join roots ⋈ edges → ONE denormalized record per ──
        // root, published via publishRecords. That chunks records into ~chunkSize
        // merkle leaves and commits ONE on-chain tx per shard — so the whole corpus
        // is a handful of txs, not one per batch. Neighbor labels are folded into the
        // record's `text` so credits/works still enrich the embedding.
        console.log("[publish] pass 4/4: publishing denormalized records");
        const ledger: Ledger = loadLedger(ledgerPath) ?? { schemaName, schemaId, rootType, shards: [] };
        ledger.shards.map(s => s.shardIndex).sort((a, b) => a - b).forEach((idx, i) => {
            if (idx !== i) throw new Error(`Ledger shard indices not a contiguous 0..N prefix (gap near ${idx.toString()}); inspect ${ledgerPath}.`);
        });
        const rootsDone = ledger.shards.reduce((sum, s) => sum + s.rootCount, 0);
        let nextShardIdx = ledger.shards.length;
        const firstNewIdx = nextShardIdx;
        if (rootsDone > 0) console.log(`[publish] resuming: ${rootsDone.toLocaleString()} roots already published across ${nextShardIdx.toString()} shard(s)`);
        console.log(`[publish] ~${recordsPerTx.toLocaleString()} records per tx, ${chunkSize.toString()} records per merkle leaf`);

        let skipped = 0, warned = 0;
        const warnSkip = (id: string, errs: string[]): void => {
            if (warned < 20) { console.warn(`   ⚠️  skipping ${rootType} "${id}": ${errs.join("; ")}`); warned++; }
            else if (warned === 20) { console.warn("   ⚠️  (further skip warnings suppressed)"); warned++; }
        };

        const MAX_TEXT = 4000;
        // One root + its outgoing edges → one conformed PublishRecord (or null if
        // it can't be made schema-valid). Neighbor labels fold into `text`.
        const makeRecord = (node: MbNode, edges: [string, string][]): PublishRecord | null => {
            const fields = conformFields(node.fields, recordingDef);
            const labels: string[] = [];
            for (const [rel, to] of edges) {
                const label = neighborLabels.get(to);
                if (label) labels.push(`${rel}: ${label}`);
            }
            if (labels.length) {
                const base = typeof fields.text === "string" ? fields.text : "";
                fields.text = `${base} | ${labels.join("; ")}`.slice(0, MAX_TEXT);
            }
            const errs = recordErrors(fields, recordingDef);
            if (errs.length) { warnSkip(node.name, errs); return null; }
            return { name: node.name, fields };
        };

        // Merge roots.sorted (by id) ⋈ edges.sorted (by from), both byte-ordered,
        // yielding one record per valid root. `seen` is the 1-based root index, used
        // for offset resume (skip the first `rootsDone` roots, still consuming their
        // edges to stay aligned).
        async function* recordGen(): AsyncIterable<{ record: PublishRecord; seen: number }> {
            const edgeRl = createInterface({ input: createReadStream(edgesSorted, { highWaterMark: 1 << 20 }), crlfDelay: Infinity });
            try {
                const edgeIter = edgeRl[Symbol.asyncIterator]();
                const readEdge = async (): Promise<[string, string, string] | null> => {
                    const er = await edgeIter.next();
                    if (er.done) return null;
                    const line = er.value;
                    const a = line.indexOf("\t");
                    const b = line.indexOf("\t", a + 1);
                    return [line.slice(0, a), line.slice(a + 1, b), line.slice(b + 1)];
                };
                let cur = await readEdge();
                let seen = 0;
                for await (const node of streamJsonArray<MbNode>(rootsSorted)) {
                    seen++;
                    while (cur !== null && cur[0] < node.name) cur = await readEdge();
                    const edges: [string, string][] = [];
                    while (cur !== null && cur[0] === node.name) { edges.push([cur[1], cur[2]]); cur = await readEdge(); }
                    if (seen <= rootsDone) continue; // already published in a prior run
                    const rec = makeRecord(node, edges);
                    if (!rec) continue;
                    yield { record: rec, seen };
                }
            } finally {
                edgeRl.close();
            }
        }

        // Publish in shards of ~recordsPerTx records; each shard = one publishRecords
        // call = one merkle tree = one on-chain tx. Buffer the shard so a transient
        // retry can re-iterate the same records.
        const it = recordGen()[Symbol.asyncIterator]();
        let rootTotal = 0;
        let prevSeen = rootsDone;
        for (;;) {
            const shard: PublishRecord[] = [];
            let maxSeen = prevSeen;
            while (shard.length < recordsPerTx) {
                const r = await it.next();
                if (r.done) break;
                shard.push(r.value.record);
                maxSeen = r.value.seen;
            }
            if (shard.length === 0) break;
            const thisIdx = nextShardIdx++;
            const shardDataset = `${opts.dataset}.shard${thisIdx.toString()}`;
            console.log(`[publish] shard ${thisIdx.toString()}: ${shard.length.toLocaleString()} records → ${shardDataset}`);
            const { manifestUri, entryCount } = await withRetry(
                `shard ${thisIdx.toString()}`,
                maxRetries,
                () => fangorn.publisher.publishRecords({ records: shard, schemaName, datasetName: shardDataset, chunkSize, concurrency }),
            );
            rootTotal += shard.length;
            ledger.shards.push({ shardIndex: thisIdx, dataset: shardDataset, manifestUri, rootCount: maxSeen - prevSeen, recordCount: shard.length, publishedAt: new Date().toISOString() });
            saveLedger(ledgerPath, ledger);
            prevSeen = maxSeen;
            console.log(`  ✓ manifest: ${manifestUri} (${entryCount.toString()} leaves)`);
            if (batchDelay > 0) await new Promise(r => setTimeout(r, batchDelay));
        }

        console.log(`\n✅ Published ${rootTotal.toLocaleString()} new records across ${(nextShardIdx - firstNewIdx).toString()} new shard(s)/tx(s).\n`);
        if (skipped) console.log(`  ⚠️  skipped ${skipped.toLocaleString()} malformed record(s)`);
        console.log(`  schema name : ${schemaName}`);
        console.log(`  schema id   : ${schemaId}`);
        console.log(`  shards/txs  : ${ledger.shards.length.toString()}`);
        console.log(`  ledger      : ${ledgerPath}`);
        console.log("\nBuild embeddings with:\n");
        console.log(`  quickbeam build \\`);
        console.log(`    --schema "${schemaName}=${schemaId}" \\`);
        console.log(`    --primary "${schemaName}" \\`);
        console.log(`    --reset\n`);
    } finally {
        rmSync(workDir, { recursive: true, force: true });
    }
}

main().catch((err: unknown) => {
    console.error("\n[publish] failed:", err);
    process.exit(1);
});
