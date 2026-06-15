/**
 * Publish MusicBrainz dump data to Fangorn as a v3 bundle.
 *
 * This script registers the Track + TrackTaxonomy node schemas and the
 * hasTaxonomy bundle schema (all idempotent — safe to re-run), then publishes
 * the JSON chunk files produced by `quickbeam data mb` as a sequence of
 * ManifestPublished events consumable by `quickbeam build --bundle`.
 *
 * ─── SETUP ───────────────────────────────────────────────────────────────────
 * This file must be placed alongside setup-embeddings-testdata.ts in the
 * fangorn-sdk repo (src/publish_mb_bundle.ts) to resolve its imports.
 *
 * Run from the fangorn-sdk root:
 *   pnpm dotenvx run -f .env -- tsx src/test/publish_mb_bundle.ts \
 *     --tracks   /path/to/volume_1_tracks.json \
 *     --taxonomies /path/to/volume_1_taxonomies.json \
 *     --edges    /path/to/volume_1_edges.json \
 *     --dataset  ds.mb.v1
 *
 * Optional flags:
 *   --batch-size <n>         Nodes per publishBundle call (default 2000)
 *   --bundle-name <name>     Override bundle schema name (default fangorn.mb.bundle.v1)
 *   --track-schema <name>    Override Track schema name
 *   --taxonomy-schema <name> Override TrackTaxonomy schema name
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, createReadStream, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import streamArray from "stream-json/streamers/stream-array.js";
import { open, type Database, type Key } from "lmdb";
import { program } from "commander";
import { createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { TestBed } from "./testbed.js";
import { BundleInput, SchemaDefinition } from "../roles/schema/types.js";
import { FieldInput } from "../roles/publisher/types.js";

// ── env (mirrors setup-embeddings-testdata.ts) ────────────────────────────────
const SK = process.env.DELEGATOR_ETH_PRIVATE_KEY as Hex;
const RPC_URL = process.env.RPC_URL ?? process.env.CHAIN_RPC_URL ?? "https://sepolia-rollup.arbitrum.io/rpc";
const WORKER_URL = process.env.WORKER_URL ?? "http://localhost:8787";
const SETTLEMENT_REGISTRY_ADDRESS = process.env.SETTLEMENT_REGISTRY_ADDRESS as Address;
const DATA_SOURCE_REGISTRY_ADDRESS = process.env.DATA_SOURCE_REGISTRY_ADDRESS as Address;
const SCHEMA_REGISTRY_ADDRESS = process.env.SCHEMA_REGISTRY_ADDRESS as Address;
const USDC_ADDRESS = (process.env.USDC_ADDRESS ?? process.env.USDC_CONTRACT_ADDRESS ?? "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d") as Address;
const USDC_DOMAIN = "USD Coin";
const CHAIN = arbitrumSepolia;

// ── schema definitions ────────────────────────────────────────────────────────
// Must match the fields produced by quickbeam/pipelines/mb.py.

const TRACK_SCHEMA: SchemaDefinition = {
    schemaVersion: { "@type": "number" },
    trackId: { "@type": "string" },
    isrcCode: { "@type": "string | null" },
    title: { "@type": "string" },
    byArtist: { "@type": "string" },
    albumName: { "@type": "string | null" },
    datePublished: { "@type": "string | null" },
    durationMs: { "@type": "number | null" },
    contributors: { "@type": "array", items: { role: { "@type": "string | null" }, name: { "@type": "string | null" }, id: { "@type": "string | null" } } },
};

const TAXONOMY_SCHEMA: SchemaDefinition = {
    schemaVersion: { "@type": "number" },
    trackId: { "@type": "string" },
    genres: { "@type": "array", items: { "@type": "string" } },
    moods: { "@type": "array", items: { "@type": "string" } },
    themes: { "@type": "array", items: { "@type": "string" } },
    contexts: { "@type": "array", items: { "@type": "string" } },
};

// ── types matching mb.py output ───────────────────────────────────────────────
interface MbNode { name: string; fields: Record<string, unknown> }
interface MbEdge { rel: string; from: string; to: string }

/**
 * Stream the elements of a top-level JSON array file one at a time. Avoids
 * readFileSync()+JSON.parse(), which materializes the whole file as a single
 * string (>512MB hits V8's ERR_STRING_TOO_LONG) plus a full object-graph copy.
 */
async function* streamJsonArray<T>(path: string): AsyncIterable<T> {
    const pipeline = createReadStream(path).pipe(streamArray.withParserAsStream());
    for await (const { value } of pipeline as AsyncIterable<{ value: T }>) yield value;
}

/**
 * Stream a JSON-array file into an LMDB sub-database in committed batches, so the
 * full index lives on disk (memory-mapped) instead of the JS heap. `keyFn`
 * derives each record's key; `seq` is a per-call running counter for composite keys.
 * Returns the number of records written.
 */
async function bulkLoad<T>(
    db: Database,
    source: AsyncIterable<T>,
    keyFn: (item: T, seq: number) => Key,
): Promise<number> {
    const BATCH = 20_000;
    let buf: [Key, T][] = [];
    let n = 0;
    const commit = () => {
        const pending = buf;
        buf = [];
        db.transactionSync(() => {
            for (const [k, v] of pending) db.putSync(k, v);
        });
    };
    for await (const item of source) {
        buf.push([keyFn(item, n), item]);
        n++;
        if (buf.length >= BATCH) commit();
    }
    if (buf.length) commit();
    return n;
}

/** Strip undefined values; null is kept so nullable schema fields validate correctly. */
function cleanFields(raw: Record<string, unknown>): Record<string, FieldInput> {
    const out: Record<string, FieldInput> = {};
    for (const [k, v] of Object.entries(raw)) {
        if (v !== undefined) {
            out[k] = v as FieldInput;
        }
    }
    return out;
}

// ── retry ─────────────────────────────────────────────────────────────────────
async function withRetry<T>(label: string, maxAttempts: number, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (attempt === maxAttempts) throw err;
            const delayMs = 2000 * attempt;
            console.warn(`  [retry] ${label} failed (attempt ${attempt.toString()}/${maxAttempts.toString()}), retrying in ${(delayMs / 1000).toString()}s: ${(err as Error).message}`);
            await new Promise(r => setTimeout(r, delayMs));
        }
    }
    throw new Error("unreachable");
}

// ── ledger ────────────────────────────────────────────────────────────────────
interface BatchEntry {
    batchIndex: number;
    dataset: string;
    manifestUri: string;
    trackCount: number;
    publishedAt: string;
}
interface Ledger {
    bundleName: string;
    bundleSchemaId: Hex;
    batches: BatchEntry[];
}

function loadLedger(path: string): Ledger | null {
    if (!existsSync(path)) return null;
    try { return JSON.parse(readFileSync(path, "utf8")) as Ledger; } catch { return null; }
}

function saveLedger(path: string, ledger: Ledger): void {
    mkdirSync("tmp", { recursive: true });
    writeFileSync(path, JSON.stringify(ledger, null, 2));
}

// ── main ──────────────────────────────────────────────────────────────────────
program
    .requiredOption("--tracks <path>", "volume_N_tracks.json from quickbeam data mb")
    .requiredOption("--taxonomies <path>", "volume_N_taxonomies.json")
    .requiredOption("--edges <path>", "volume_N_edges.json")
    .requiredOption("--dataset <name>", "Base dataset name, e.g. ds.mb.v1")
    .option("--batch-size <n>", "Track nodes per publishBundle call", "2000")
    .option("--bundle-name <name>", "Bundle schema name", "fangorn.mb.bundle.v1")
    .option("--bundle-schema-id <hex>", "Reuse an existing bundle schema ID and skip registration")
    .option("--track-schema <name>", "Track node schema name", "sond3r.track.invariants.v1")
    .option("--taxonomy-schema <name>", "TrackTaxonomy node schema name", "sond3r.track.taxonomy.v1")
    .option("--ledger <path>", "Ledger file path (default: tmp/mb-publish-<dataset>.json)")
    .option("--index-dir <path>", "Directory for the temporary on-disk LMDB index — MUST be on real disk, not tmpfs/RAM", "tmp")
    .option("--max-retries <n>", "Retry attempts per batch on transient failures", "5")
    .parse();

const opts = program.opts<{
    tracks: string; taxonomies: string; edges: string;
    dataset: string; batchSize: string;
    bundleName: string;
    bundleSchemaId?: string;
    trackSchema: string;
    taxonomySchema: string;
    ledger?: string;
    indexDir: string;
    maxRetries: string;
}>();

function requireEnv(): void {
    const missing: string[] = [];
    if (SK === "0x") missing.push("DELEGATOR_ETH_PRIVATE_KEY");
    if (DATA_SOURCE_REGISTRY_ADDRESS === "0x") missing.push("DATA_SOURCE_REGISTRY_ADDRESS");
    if (SCHEMA_REGISTRY_ADDRESS === "0x") missing.push("SCHEMA_REGISTRY_ADDRESS");
    if (!process.env.PINATA_JWT) missing.push("PINATA_JWT");
    if (missing.length) {
        throw new Error(`Missing env vars: ${missing.join(", ")}`);
    }
}

async function main(): Promise<void> {
    requireEnv();

    const batchSize = parseInt(opts.batchSize, 10);
    const maxRetries = parseInt(opts.maxRetries, 10);

    const testbed = TestBed.init(
        createWalletClient({ account: privateKeyToAccount(SK), chain: CHAIN, transport: http(RPC_URL) }),
        DATA_SOURCE_REGISTRY_ADDRESS,
        SCHEMA_REGISTRY_ADDRESS,
        SETTLEMENT_REGISTRY_ADDRESS,
        USDC_ADDRESS,
        USDC_DOMAIN,
        RPC_URL,
        "arbitrumSepolia",
        CHAIN.id,
        WORKER_URL,
    );

    // ── 1. Register schemas (idempotent) ─────────────────────────────────────
    console.log("[publish] registering node schemas...");
    await testbed.registerSchema(opts.trackSchema, TRACK_SCHEMA);
    await testbed.registerSchema(opts.taxonomySchema, TAXONOMY_SCHEMA);

    let bundleSchemaId: Hex;
    if (opts.bundleSchemaId) {
        bundleSchemaId = opts.bundleSchemaId as Hex;
        console.log(`[publish] reusing bundle schema id: ${bundleSchemaId}`);
    } else {
        console.log("[publish] registering bundle shape...");
        const bundle: BundleInput = {
            nodes: { Track: opts.trackSchema, TrackTaxonomy: opts.taxonomySchema },
            edges: [{ rel: "hasTaxonomy", from: "Track", to: "TrackTaxonomy", min: 1, max: 1 }],
        };
        bundleSchemaId = await testbed.registerBundle(opts.bundleName, bundle);
        console.log(`[publish] bundle schema id: ${bundleSchemaId}`);
    }

    const ledgerPath = opts.ledger ?? `tmp/mb-publish-${opts.dataset.replace(/[^a-z0-9._-]/gi, "_")}.json`;

    // ── 2. Index taxonomies + edges on disk (LMDB) ────────────────────────────
    // The taxonomy/edge lookups are random-access by track name and far too
    // large to hold in the JS heap (multi-GB each). We stream them into a
    // memory-mapped LMDB index instead: taxonomies keyed by track name, edges
    // under composite [from, seq] keys so a track's edges are a contiguous range.
    // The index can be several GB — it MUST live on a real disk, not tmpfs/RAM
    // (e.g. the default /tmp on Linux is RAM-backed). Default to the project's
    // tmp/ dir on the same disk as the data; override with --index-dir.
    const indexBase = resolve(opts.indexDir);
    mkdirSync(indexBase, { recursive: true });
    const indexDir = mkdtempSync(join(indexBase, "mb-index-"));
    console.log(`[publish] LMDB index dir: ${indexDir}`);
    // noSync: this index is rebuilt every run, so durability is irrelevant —
    // skipping fsync makes the bulk load dramatically faster.
    const indexEnv = open({ path: indexDir, compression: false, noSync: true, maxDbs: 2 });
    const taxoDb = indexEnv.openDB({ name: "taxo" });
    const edgeDb = indexEnv.openDB({ name: "edge" });

    try {
        console.log("[publish] indexing taxonomies + edges (on-disk LMDB)...");
        const taxoCount = await bulkLoad<MbNode>(taxoDb, streamJsonArray<MbNode>(opts.taxonomies), t => t.name);
        const edgeCount = await bulkLoad<MbEdge>(edgeDb, streamJsonArray<MbEdge>(opts.edges), (e, seq) => [e.from, seq]);
        console.log(`[publish] ${taxoCount.toString()} taxonomies, ${edgeCount.toString()} edges indexed → ${indexDir}`);

        // ── 3. Stream tracks and publish in batches (resumable via ledger) ────
        const ledger: Ledger = loadLedger(ledgerPath) ?? {
            bundleName: opts.bundleName,
            bundleSchemaId,
            batches: [],
        };

        // Resume by TRACK OFFSET, not batch index — this stays correct even when
        // --batch-size changes between runs. A failed batch aborts the run, so the
        // ledger is always a contiguous 0..N-1 prefix covering the first
        // `tracksDone` tracks; assert that before trusting the offset.
        const sortedIdx = ledger.batches.map(b => b.batchIndex).sort((a, b) => a - b);
        sortedIdx.forEach((idx, i) => {
            if (idx !== i) {
                throw new Error(
                    `Ledger batch indices are not a contiguous 0..N prefix (gap near index ${idx.toString()}); ` +
                    `offset-based resume would be unsafe. Inspect ${ledgerPath}.`,
                );
            }
        });
        const tracksDone = ledger.batches.reduce((sum, b) => sum + b.trackCount, 0);
        let nextBatchIdx = ledger.batches.length;
        const firstNewIdx = nextBatchIdx;
        if (tracksDone > 0) {
            console.log(`[publish] resuming: ${tracksDone.toString()} tracks already published across ${nextBatchIdx.toString()} batches — skipping those`);
        }
        console.log(`[publish] publishing remaining tracks in batches of up to ${batchSize.toString()}`);

        let seen = 0;
        let trackTotal = 0;
        let batchTracks: MbNode[] = [];

        const flushBatch = async (): Promise<void> => {
            const tracks = batchTracks;
            batchTracks = []; // release the batch buffer immediately
            if (tracks.length === 0) return;
            const thisIdx = nextBatchIdx++;
            const batchDataset = `${opts.dataset}.batch${thisIdx.toString()}`;

            const batchNodes: { id: string; type: string; fields: Record<string, FieldInput> }[] = [];
            const batchEdges: MbEdge[] = [];
            for (const track of tracks) {
                batchNodes.push({ id: track.name, type: "Track", fields: cleanFields(track.fields) });
                const taxo = taxoDb.get(track.name) as MbNode | undefined;
                if (taxo) {
                    batchNodes.push({ id: `taxonomy:${taxo.name}`, type: "TrackTaxonomy", fields: cleanFields(taxo.fields) });
                }
                // all edges whose `from === track.name` are the contiguous [name, *] range
                for (const { value } of edgeDb.getRange({ start: [track.name], end: [`${track.name}\x00`] })) {
                    batchEdges.push(value as MbEdge);
                }
            }

            console.log(`[publish] batch ${thisIdx.toString()}: ${tracks.length.toString()} tracks → ${batchDataset}`);
            const manifestUri = await withRetry(
                `batch ${thisIdx.toString()}`,
                maxRetries,
                () => testbed.publishBundle(opts.bundleName, batchNodes, batchEdges, batchDataset),
            );

            ledger.batches.push({
                batchIndex: thisIdx,
                dataset: batchDataset,
                manifestUri,
                trackCount: tracks.length,
                publishedAt: new Date().toISOString(),
            });
            saveLedger(ledgerPath, ledger);
            console.log(`  ✓ manifest: ${manifestUri}`);
        };

        for await (const track of streamJsonArray<MbNode>(opts.tracks)) {
            seen++;
            if (seen <= tracksDone) continue; // already published in a prior run
            batchTracks.push(track);
            trackTotal++;
            if (batchTracks.length >= batchSize) await flushBatch();
        }
        await flushBatch();
        console.log(`[publish] ${trackTotal.toString()} new tracks across ${(nextBatchIdx - firstNewIdx).toString()} new batches`);

    console.log("\n✅ All batches published.\n");
    console.log(`  bundle name : ${opts.bundleName}`);
    console.log(`  bundle id   : ${bundleSchemaId}`);
    console.log(`  batches     : ${ledger.batches.length.toString()}`);
    console.log(`  ledger      : ${ledgerPath}`);
    console.log("\nBuild embeddings with:\n");
    console.log(`  quickbeam build \\`);
    console.log(`    --bundle "${opts.bundleName}=${bundleSchemaId}" \\`);
    console.log(`    --root-type Track \\`);
    console.log(`    --reset\n`);
    } finally {
        // Tear down the temporary on-disk index.
        await indexEnv.close();
        rmSync(indexDir, { recursive: true, force: true });
    }
}

main().catch((err: unknown) => {
    console.error("\n[publish] failed:", err);
    process.exit(1);
});
