/**
 * Publish the FULL MusicBrainz graph to Fangorn as ONE bundle commitment (one tx).
 *
 * Streams every node (all types) and every edge straight into `publishBundle`,
 * which now chunks them into ~chunkSize merkle leaves (nodes per type + edges,
 * many leaves) under a SINGLE root → ONE `dataSourceRegistry.publish` → ONE tx.
 * No giant chunk, no JSON.stringify 512MB wall, memory ~ one chunk at a time.
 *
 * The builder consumes it with the bundle as the shape:
 *   quickbeam build --bundle "fangorn.mb.creativecore.v1=<id>" --root-type Recording
 *
 *   dotenvx run -f .env -- tsx src/test/publish_bundle.ts \
 *     --input-dir /home/driemworks/fangorn/embeddings/stage_volumes
 *
 * Requires env (or ~/.fangorn/config.json): DELEGATOR_ETH_PRIVATE_KEY, PINATA_JWT,
 * PINATA_GATEWAY, CHAIN_NAME[, RPC_URL].
 */

import { readFileSync, writeFileSync, existsSync, createReadStream, createWriteStream, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
import { type FieldInput } from "../roles/publisher/types.js";

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
interface NodeSchemaFile { name: string; definition: SchemaDefinition }
interface BundleSchemaFile { name: string; kind: "bundle"; bundle: BundleInput }
interface ConsolidatedSchemas { schemas: NodeSchemaFile[]; bundle: BundleSchemaFile }
interface MbNode { name: string; fields: Record<string, unknown> }
interface MbEdge { rel: string; from: string; to: string; fromType?: string; toType?: string }

const TYPE_FILE: Record<string, string> = {
    Artist: "artists", Recording: "recordings", ReleaseGroup: "releasegroups", Release: "releases", Work: "works",
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

// ── schema conformance (schemas inferred from a sample → over-constrained) ─────
function defaultFor(b: string): FieldInput { return b === "number" ? 0 : b === "boolean" ? false : b === "array" ? [] : b === "object" ? {} : ""; }
function coerce(v: unknown, b: string, nul: boolean): FieldInput {
    if (v === undefined || v === null) return nul ? null : defaultFor(b);
    switch (b) {
        case "string": return typeof v === "string" ? v : (typeof v === "number" || typeof v === "boolean") ? String(v) : JSON.stringify(v);
        case "number": if (typeof v === "number") return v; if (typeof v === "string" && v.trim() !== "") { const n = Number(v); if (Number.isFinite(n)) return n; } return nul ? null : 0;
        case "boolean": return typeof v === "boolean" ? v : typeof v === "string" ? v === "true" : Boolean(v);
        case "array": return Array.isArray(v) ? (v as FieldInput) : (nul ? null : []);
        case "object": return typeof v === "object" ? (v as FieldInput) : (nul ? null : {});
        default: return v as FieldInput;
    }
}
function conformFields(raw: Record<string, unknown>, def: SchemaDefinition): Record<string, FieldInput> {
    const out: Record<string, FieldInput> = {};
    for (const [name, fd] of Object.entries(def)) {
        const rt = String(fd["@type"]);
        out[name] = coerce(raw[name], rt.replace("| null", "").trim(), rt.includes("| null"));
    }
    return out;
}

const ZERO = `0x${"0".repeat(64)}`;
async function ensureResolver(fangorn: Fangorn, name: string, definition: SchemaDefinition, skip: boolean): Promise<Hex> {
    let id: Hex | null = null;
    try {
        const registry = fangorn.getSchemaRegistry();
        const computedId = await registry.schemaId(name);
        const exists = await registry.schemaExists(computedId);

        if (exists) {
            id = computedId;
        }
    } catch { /* none */ }

    if (id) {
        console.log(`[publish] schema "${name}" already registered → ${id}`);
        return id;
    }

    if (skip) throw new Error(`--skip-register but "${name}" not registered`);

    const { schemaId } = await fangorn.schema.register({ name, definition });
    console.log(`[publish] registered "${name}" → ${schemaId}`);
    return schemaId;
}

// ── sharding helpers (sort-merge to build self-contained shards) ──────────────
function hms(ms: number): string { const s = Math.floor(ms / 1000); return s >= 60 ? `${Math.floor(s / 60).toString()}m${(s % 60).toString().padStart(2, "0")}s` : `${s.toString()}s`; }

/** GNU external sort — LC_ALL=C byte order matches JS string `<` on ASCII MBID keys. */
function runSort(input: string, output: string, keyArgs: string[], tmpDir: string, mem: string, parallel: number): Promise<void> {
    return new Promise((res, rej) => {
        const args = [...keyArgs, "-S", mem, `--parallel=${parallel.toString()}`, "-T", tmpDir, "-o", output, input];
        const t0 = Date.now();
        const p = spawn("sort", args, { env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "ignore", "inherit"] });
        p.on("error", rej);
        p.on("close", code => code === 0
            ? (console.log(`   sorted ${input.split("/").pop() ?? input} in ${hms(Date.now() - t0)}`), res())
            : rej(new Error(`sort exited ${code === null ? "null" : code.toString()} for ${input}`)));
    });
}

/** Fast line count via `wc -l` (one root per line in the sorted JSONL ± brackets). */
function countLines(path: string): Promise<number> {
    return new Promise((res, rej) => {
        const p = spawn("wc", ["-l", path], { stdio: ["ignore", "pipe", "ignore"] });
        let out = "";
        p.stdout.on("data", (d: Buffer) => { out += d.toString(); });
        p.on("error", rej);
        p.on("close", code => code === 0 ? res(parseInt(out.trim().split(/\s+/)[0], 10) || 0) : rej(new Error(`wc exited ${code === null ? "null" : code.toString()}`)));
    });
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

interface ShardEntry { shardIndex: number; dataset: string; manifestUri: string; rootCount: number; publishedAt: string }
interface Ledger { bundleName: string; bundleSchemaId: Hex; rootType: string; shards: ShardEntry[] }
function loadLedger(path: string): Ledger | null {
    if (!existsSync(path)) return null;
    try { const l = JSON.parse(readFileSync(path, "utf8")) as Ledger; return Array.isArray(l.shards) ? l : null; } catch { return null; }
}
function saveLedger(path: string, ledger: Ledger): void { mkdirSync("tmp", { recursive: true }); writeFileSync(path, JSON.stringify(ledger, null, 2)); }

// ── CLI ───────────────────────────────────────────────────────────────────────
program
    .option("--input-dir <path>", "Directory with volume_<n>_*.json + schemas/", "./stage_volumes")
    .option("--schemas-dir <path>", "Schema definitions dir (default <input-dir>/schemas)")
    .option("--volume <n>", "Volume number", "1")
    .option("--limit <n>", "Max entries per file (0 = all) — small value for a cheap dry run", "0")
    .option("--chunk-size <n>", "Entries per merkle leaf", "1000")
    .option("--concurrency <n>", "Parallel chunk uploads (low on a modest uplink)", "4")
    .option("--validate", "Run full cross-node graph validation (needs all node ids in RAM)", false)
    .option("--skip-register", "Don't register missing schemas; resolve existing ids only", false)
    // ── sharded mode (laptop-buildable: a few large self-contained shards) ──
    .option("--shard-roots <n>", "Roots per shard (>0 enables sharded mode; each shard = one tx, builder-RAM-bounded)", "0")
    .option("--root-type <type>", "Root node type for sharded mode", "Recording")
    .option("--dataset <name>", "Base dataset name for shards (default: ds.<bundle>)")
    .option("--index-dir <path>", "Work dir for sort spill (real disk, ~2x edge size free)", "tmp")
    .option("--sort-mem <size>", "GNU sort buffer (small = laptop-safe; spills to disk)", "256M")
    .option("--sort-parallel <n>", "GNU sort threads (default: CPU count)", "")
    .option("--ledger <path>", "Resume ledger path (default: tmp/bundle-<dataset>.json)")
    .option("--max-retries <n>", "Retry attempts per shard on transient errors", "8")
    .parse();

const opts = program.opts<{
    inputDir: string; schemasDir?: string; volume: string; limit: string;
    chunkSize: string; concurrency: string; validate: boolean; skipRegister: boolean;
    shardRoots: string; rootType: string; dataset?: string; indexDir: string;
    sortMem: string; sortParallel: string; ledger?: string; maxRetries: string;
}>();

/**
 * Sharded mode: build self-contained root-neighborhood shards via sort-merge and
 * publish each as ONE chunked bundle tx. Self-contained = each shard's manifest
 * holds its roots + the neighbor nodes their edges point at + those edges, so the
 * builder folds within one manifest's RAM (consume one shard at a time). A handful
 * of large shards → a handful of txs, laptop-BUILDABLE.
 */
async function publishSharded(
    fangorn: Fangorn,
    inputDir: string,
    volume: number,
    bundle: BundleSchemaFile,
    bundleId: Hex,
    defByName: Map<string, SchemaDefinition>,
    o: { shardRoots: number; chunkSize: number; concurrency: number; limit: number },
): Promise<void> {
    const rootType = opts.rootType;
    const rootSchemaName = bundle.bundle.nodes[rootType];
    if (!rootSchemaName) throw new Error(`--root-type "${rootType}" not in bundle.nodes (have: ${Object.keys(bundle.bundle.nodes).join(", ")})`);
    const rootDef = defByName.get(rootSchemaName);
    if (!rootDef) throw new Error(`no definition for ${rootSchemaName}`);
    const rootPath = join(inputDir, `volume_${volume.toString()}_${TYPE_FILE[rootType] ?? rootType.toLowerCase()}.json`);
    if (!existsSync(rootPath)) throw new Error(`Not found: ${rootPath}`);
    const edgesPath = join(inputDir, `volume_${volume.toString()}_edges.json`);
    if (!existsSync(edgesPath)) throw new Error(`Not found: ${edgesPath}`);

    const declaredEdges = new Set(bundle.bundle.edges.map(e => `${e.rel}:${e.from}:${e.to}`));
    const neighborTypes = new Set<string>();
    for (const e of bundle.bundle.edges) if (e.from === rootType) neighborTypes.add(e.to);

    const dataset = opts.dataset ?? `ds.${bundle.name}`;
    const ledgerPath = opts.ledger ?? `tmp/bundle-${dataset.replace(/[^a-z0-9._-]/gi, "_")}.json`;
    const maxRetries = Math.max(1, parseInt(opts.maxRetries, 10) || 8);
    const sortMem = opts.sortMem;
    const sortPar = parseInt(opts.sortParallel, 10) || cpus().length;

    const workBase = resolve(opts.indexDir);
    mkdirSync(workBase, { recursive: true });
    const workDir = mkdtempSync(join(workBase, "bundle-work-"));
    const edgesTsv = join(workDir, "edges.tsv");
    const edgesSorted = join(workDir, "edges.sorted.tsv");
    const rootsSorted = join(workDir, "roots.sorted.jsonl");
    console.log(`[publish] sharded mode: root=${rootType}, ${o.shardRoots.toLocaleString()} roots/shard; work dir ${workDir}`);

    try {
        // ── pass 1/4: root-origin declared edges → flat TSV; collect neighbor ids ──
        console.log(`[publish] pass 1/4: extracting ${rootType}-origin edges...`);
        const neededIds = new Set<string>();
        {
            const out = createWriteStream(edgesTsv);
            let scanned = 0, kept = 0;
            for await (const e of streamJsonArray<MbEdge>(edgesPath, o.limit)) {
                scanned++;
                if (scanned % 5_000_000 === 0) process.stdout.write(`\r   scanned ${scanned.toLocaleString()}, kept ${kept.toLocaleString()}...   `);
                if (!(e.from && e.to && e.fromType === rootType)) continue;
                if (!declaredEdges.has(`${e.rel}:${e.fromType}:${e.toType ?? ""}`)) continue;
                neededIds.add(e.to); kept++;
                if (!out.write(`${e.from}\t${e.rel}\t${e.to}\n`)) await once(out, "drain");
            }
            await new Promise<void>((res, rej) => { out.end((err?: Error | null) => { if (err) rej(err); else res(); }); });
            process.stdout.write("\n");
            console.log(`[publish]   kept ${kept.toLocaleString()} edges; ${neededIds.size.toLocaleString()} distinct neighbors`);
        }

        // ── pass 2/4: external sort (edges by from, roots by id) ──────────────
        console.log(`[publish] pass 2/4: external sort (mem=${sortMem}, parallel=${sortPar.toString()})...`);
        await runSort(edgesTsv, edgesSorted, ["-t", "\t", "-k", "1,1"], workDir, sortMem, sortPar);
        await runSort(rootPath, rootsSorted, [], workDir, sortMem, sortPar);

        // ── pass 3/4: load needed neighbor nodes (conformed, as compact JSON) ──
        console.log(`[publish] pass 3/4: loading neighbor nodes (${[...neighborTypes].join(", ")})...`);
        const neighborNode = new Map<string, { type: string; fields: string }>();
        for (const type of neighborTypes) {
            const def = defByName.get(bundle.bundle.nodes[type]);
            const path = join(inputDir, `volume_${volume.toString()}_${TYPE_FILE[type] ?? type.toLowerCase()}.json`);
            if (!def || !existsSync(path)) { console.warn(`   ⚠️  skipping neighbor type ${type}`); continue; }
            for await (const node of streamJsonArray<MbNode>(path, o.limit)) {
                if (neededIds.delete(node.name)) neighborNode.set(node.name, { type, fields: JSON.stringify(conformFields(node.fields, def)) });
            }
        }
        neededIds.clear();
        console.log(`[publish]   ${neighborNode.size.toLocaleString()} neighbor nodes in memory`);

        // ── pass 4/4: merge-join roots ⋈ edges → self-contained shard → one tx ──
        const totalRoots = await countLines(rootsSorted);
        const totalShards = Math.max(1, Math.ceil(totalRoots / o.shardRoots));
        console.log(`[publish] pass 4/4: publishing ${totalShards.toLocaleString()} shard(s) (~${totalRoots.toLocaleString()} roots, one tx each)...`);
        const ledger: Ledger = loadLedger(ledgerPath) ?? { bundleName: bundle.name, bundleSchemaId: bundleId, rootType, shards: [] };
        ledger.shards.map(s => s.shardIndex).sort((a, b) => a - b).forEach((idx, i) => { if (idx !== i) throw new Error(`ledger not a contiguous 0..N prefix near ${idx.toString()}; inspect ${ledgerPath}`); });
        const rootsDone = ledger.shards.reduce((s, x) => s + x.rootCount, 0);
        let nextShard = ledger.shards.length;
        if (rootsDone > 0) console.log(`[publish]   resuming: ${rootsDone.toLocaleString()} roots done across ${nextShard.toString()} shard(s)`);

        const edgeRl = createInterface({ input: createReadStream(edgesSorted, { highWaterMark: 1 << 20 }), crlfDelay: Infinity });
        const edgeIter = edgeRl[Symbol.asyncIterator]();
        const readEdge = async (): Promise<[string, string, string] | null> => {
            const r = await edgeIter.next();
            if (r.done) return null;
            const line = r.value; const a = line.indexOf("\t"); const b = line.indexOf("\t", a + 1);
            return [line.slice(0, a), line.slice(a + 1, b), line.slice(b + 1)];
        };
        let cur = await readEdge();

        let seen = 0, rootTotal = 0;
        let batch: { node: MbNode; edges: [string, string][] }[] = [];

        // ETA is over shards published THIS run (resumed shards have no timing).
        const t0run = Date.now();
        let shardsThisRun = 0;

        const flush = async (): Promise<void> => {
            const roots = batch; batch = [];
            if (roots.length === 0) return;
            const idx = nextShard++;
            const shardDataset = `${dataset}.shard${idx.toString()}`;
            const ids = new Set<string>();
            const seenEdge = new Set<string>();
            const batchNodes: { id: string; type: string; fields: Record<string, FieldInput> }[] = [];
            const batchEdges: { rel: string; from: string; to: string }[] = [];
            const add = (id: string, type: string, fields: Record<string, FieldInput>): void => { if (!ids.has(id)) { ids.add(id); batchNodes.push({ id, type, fields }); } };
            for (const { node, edges } of roots) {
                add(node.name, rootType, conformFields(node.fields, rootDef));
                for (const [rel, to] of edges) {
                    const nb = neighborNode.get(to);
                    if (!nb) continue; // neighbor outside corpus — skip (build would skip it too)
                    add(to, nb.type, JSON.parse(nb.fields) as Record<string, FieldInput>);
                    const ek = `${rel}\x00${node.name}\x00${to}`;
                    if (seenEdge.has(ek)) continue; seenEdge.add(ek);
                    batchEdges.push({ rel, from: node.name, to });
                }
            }
            console.log(`[publish] shard ${idx.toString()}: ${roots.length.toLocaleString()} roots, ${batchNodes.length.toLocaleString()} nodes, ${batchEdges.length.toLocaleString()} edges → ${shardDataset}`);
            const r = await withRetry(`shard ${idx.toString()}`, maxRetries, () => fangorn.publisher.publishBundle({
                bundleName: bundle.name, nodes: batchNodes, edges: batchEdges, datasetName: shardDataset, chunkSize: o.chunkSize, concurrency: o.concurrency, validate: false,
            }));
            ledger.shards.push({ shardIndex: idx, dataset: shardDataset, manifestUri: r.manifestUri, rootCount: roots.length, publishedAt: new Date().toISOString() });
            saveLedger(ledgerPath, ledger);
            shardsThisRun++;
            const done = idx + 1;
            const avg = (Date.now() - t0run) / shardsThisRun;
            const eta = Math.max(0, totalShards - done) * avg;
            console.log(`  ✓ ${r.manifestUri} (${r.entryCount.toString()} leaves) · shard ${done.toLocaleString()}/${totalShards.toLocaleString()} (${(100 * done / totalShards).toFixed(1)}%) · ${hms(avg)}/shard · ETA ${hms(eta)}`);
        };

        // Merge: roots.sorted (by id) ⋈ edges.sorted (by from). Edges consumed for
        // every root (even already-published ones) to stay in lockstep on resume.
        for await (const node of streamJsonArray<MbNode>(rootsSorted)) {
            seen++;
            while (cur !== null && cur[0] < node.name) cur = await readEdge();
            const es: [string, string][] = [];
            while (cur !== null && cur[0] === node.name) { es.push([cur[1], cur[2]]); cur = await readEdge(); }
            if (seen <= rootsDone) continue;
            batch.push({ node, edges: es });
            rootTotal++;
            if (batch.length >= o.shardRoots) await flush();
        }
        await flush();
        edgeRl.close();

        console.log(`\n✅ Published ${rootTotal.toLocaleString()} new roots; ${ledger.shards.length.toString()} shard tx(s) total.\n`);
        console.log(`  bundle id : ${bundleId}`);
        console.log(`  ledger    : ${ledgerPath}`);
        console.log("\nBuild embeddings with:\n");
        console.log(`  quickbeam build --bundle "${bundle.name}=${bundleId}" --root-type ${rootType} --reset\n`);
    } finally {
        rmSync(workDir, { recursive: true, force: true });
    }
}

async function main(): Promise<void> {
    const fangorn = makeFangorn(loadConfig());
    const inputDir = resolve(opts.inputDir);
    const schemasDir = resolve(opts.schemasDir ?? join(inputDir, "schemas"));
    const volume = parseInt(opts.volume, 10);
    const limit = parseInt(opts.limit, 10) || 0;
    const chunkSize = Math.max(1, parseInt(opts.chunkSize, 10) || 1000);
    const concurrency = Math.max(1, parseInt(opts.concurrency, 10) || 4);

    const consolidatedPath = join(schemasDir, "fangorn_schemas.json");
    if (!existsSync(consolidatedPath)) throw new Error(`Not found: ${consolidatedPath} — run \`quickbeam data schemagen\` first.`);
    const { schemas, bundle } = JSON.parse(readFileSync(consolidatedPath, "utf8")) as ConsolidatedSchemas;
    const defByName = new Map(schemas.map(s => [s.name, s.definition]));

    // node files present, in bundle.nodes order
    const typeFiles = Object.keys(bundle.bundle.nodes)
        .map(type => ({ type, schemaName: bundle.bundle.nodes[type], path: join(inputDir, `volume_${volume.toString()}_${TYPE_FILE[type] ?? type.toLowerCase()}.json`) }))
        .filter(f => { const ok = existsSync(f.path); if (!ok) console.warn(`   ⚠️  missing ${f.path} — skipping ${f.type}`); return ok; });
    const edgesPath = join(inputDir, `volume_${volume.toString()}_edges.json`);
    if (!existsSync(edgesPath)) throw new Error(`Not found: ${edgesPath}`);

    // ── register node schemas + bundle (idempotent) ───────────────────────────
    for (const { schemaName } of typeFiles) {
        const def = defByName.get(schemaName);
        if (!def) throw new Error(`No definition for ${schemaName} in ${consolidatedPath}`);
        await ensureResolver(fangorn, schemaName, def, opts.skipRegister);
    }
    let bundleId: Hex | null = null;
    try {
        const registry = fangorn.getSchemaRegistry();
        const computedId = await registry.schemaId(bundle.name);

        // Actually check if it exists on-chain, don't just rely on the ID being non-zero
        const exists = await registry.schemaExists(computedId);

        if (exists) {
            bundleId = computedId;
        }
    } catch { /* none */ }

    if (bundleId) {
        console.log(`[publish] bundle "${bundle.name}" already registered → ${bundleId}`);
    } else if (opts.skipRegister) {
        throw new Error(`--skip-register but bundle "${bundle.name}" not registered`);
    } else {
        ({ schemaId: bundleId } = await fangorn.schema.register({ kind: "bundle", name: bundle.name, bundle: bundle.bundle }));
        console.log(`[publish] registered bundle "${bundle.name}" → ${bundleId}`);
    }

    const shardRoots = parseInt(opts.shardRoots, 10) || 0;
    if (shardRoots > 0) { await publishSharded(fangorn, inputDir, volume, bundle, bundleId, defByName, { shardRoots, chunkSize, concurrency, limit }); return; }

    // ── stream nodes + edges into ONE publishBundle call (= one tx) ────────────
    let nodeCount = 0, edgeCount = 0;
    async function* nodes(): AsyncIterable<{ id: string; type: string; fields: Record<string, FieldInput> }> {
        for (const { type, schemaName, path } of typeFiles) {
            const def = defByName.get(schemaName);
            if (!def) continue;
            for await (const node of streamJsonArray<MbNode>(path, limit)) {
                nodeCount++;
                if (nodeCount % 250_000 === 0) process.stdout.write(`\r   ${nodeCount.toLocaleString()} nodes, ${edgeCount.toLocaleString()} edges streamed...   `);
                yield { id: node.name, type, fields: conformFields(node.fields, def) };
            }
        }
    }
    async function* edges(): AsyncIterable<MbEdge> {
        for await (const e of streamJsonArray<MbEdge>(edgesPath, limit)) {
            if (!(e.rel && e.from && e.to)) continue;
            edgeCount++;
            if (edgeCount % 1_000_000 === 0) process.stdout.write(`\r   ${nodeCount.toLocaleString()} nodes, ${edgeCount.toLocaleString()} edges streamed...   `);
            yield { rel: e.rel, from: e.from, to: e.to };
        }
    }

    console.log(`[publish] streaming the full graph into ONE bundle commitment (${chunkSize.toString()}/leaf, one root, one tx)...`);
    console.log(`[publish]   node types: ${typeFiles.map(f => f.type).join(", ")} + edges${limit ? `  (limit ${limit.toLocaleString()}/file)` : ""}`);
    if (!opts.validate) console.log(`[publish]   validate=false (per-record schema validation still on; skips the in-memory node-id graph checks)`);

    const r = await fangorn.publisher.publishBundle({
        bundleName: bundle.name,
        nodes: nodes(),
        edges: edges(),
        datasetName: undefined, // single dataset under the bundle schema
        chunkSize,
        concurrency,
        validate: opts.validate,
    });
    process.stdout.write("\n");

    console.log(`\n✅ Committed the full graph as ONE bundle tx.\n`);
    console.log(`  bundle name : ${bundle.name}`);
    console.log(`  bundle id   : ${bundleId}`);
    console.log(`  nodes/edges : ${nodeCount.toLocaleString()} / ${edgeCount.toLocaleString()}`);
    console.log(`  leaves      : ${r.entryCount.toString()}`);
    console.log(`  manifest cid: ${r.manifestUri}`);
    console.log("\nBuild embeddings with:\n");
    console.log(`  quickbeam build --bundle "${bundle.name}=${bundleId}" --root-type Recording --reset\n`);
}

main().catch((err: unknown) => { console.error("\n[publish] failed:", err); process.exit(1); });
