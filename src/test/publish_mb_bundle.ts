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
 *   pnpm dotenvx run -f .env -- tsx src/publish_mb_bundle.ts \
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

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
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
    trackId: { "@type": "string" },
    isrcCode: { "@type": "string" },
    title: { "@type": "string" },
    byArtist: { "@type": "string" },
    albumName: { "@type": "string" },
    datePublished: { "@type": "string" },
    durationMs: { "@type": "number" },
    _mbid: { "@type": "string" },
};

const TAXONOMY_SCHEMA: SchemaDefinition = {
    trackId: { "@type": "string" },
    genres: { "@type": "string[]" },
    moods: { "@type": "string[]" },
    themes: { "@type": "string[]" },
    contexts: { "@type": "string[]" },
};

// ── types matching mb.py output ───────────────────────────────────────────────
type MbNode = { id: string; type: string; fields: Record<string, unknown> };
type MbEdge = { rel: string; from: string; to: string };

/** Strip null/undefined values; the SDK expects only defined FieldInput values. */
function cleanFields(raw: Record<string, unknown>): Record<string, FieldInput> {
    const out: Record<string, FieldInput> = {};
    for (const [k, v] of Object.entries(raw)) {
        if (v !== null && v !== undefined) {
            out[k] = v as FieldInput;
        }
    }
    return out;
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
    .option("--track-schema <name>", "Track node schema name", "fangorn.mb.track.v1")
    .option("--taxonomy-schema <name>", "TrackTaxonomy node schema name", "fangorn.mb.track.taxonomy.v1")
    .option("--ledger <path>", "Ledger file path for resume tracking", "tmp/mb-publish-ledger.json")
    .parse();

const opts = program.opts<{
    tracks: string; taxonomies: string; edges: string;
    dataset: string; batchSize: string;
    bundleName: string; trackSchema: string; taxonomySchema: string;
    ledger: string;
}>();

function requireEnv(): void {
    const missing: string[] = [];
    if (!SK) missing.push("DELEGATOR_ETH_PRIVATE_KEY");
    if (!DATA_SOURCE_REGISTRY_ADDRESS) missing.push("DATA_SOURCE_REGISTRY_ADDRESS");
    if (!SCHEMA_REGISTRY_ADDRESS) missing.push("SCHEMA_REGISTRY_ADDRESS");
    if (!process.env.PINATA_JWT) missing.push("PINATA_JWT");
    if (missing.length) {
        throw new Error(`Missing env vars: ${missing.join(", ")}`);
    }
}

async function main(): Promise<void> {
    requireEnv();

    const batchSize = parseInt(opts.batchSize, 10);

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

    console.log("[publish] registering bundle shape...");
    const bundle: BundleInput = {
        nodes: { Track: opts.trackSchema, TrackTaxonomy: opts.taxonomySchema },
        edges: [{ rel: "hasTaxonomy", from: "Track", to: "TrackTaxonomy", min: 1, max: 1 }],
    };
    const bundleSchemaId = await testbed.registerBundle(opts.bundleName, bundle);
    console.log(`[publish] bundle schema id: ${bundleSchemaId}`);

    // ── 2. Load data ──────────────────────────────────────────────────────────
    console.log("[publish] loading JSON files...");
    const allTracks: MbNode[] = JSON.parse(readFileSync(opts.tracks, "utf8"));
    const allTaxonomies: MbNode[] = JSON.parse(readFileSync(opts.taxonomies, "utf8"));
    const allEdges: MbEdge[] = JSON.parse(readFileSync(opts.edges, "utf8"));

    // Index taxonomies by the track id they belong to (id = "taxonomy:<tid>")
    const taxoByTrack = new Map<string, MbNode>(
        allTaxonomies.map(t => [t.id.replace(/^taxonomy:/, ""), t])
    );
    const edgesByTrack = new Map<string, MbEdge[]>();
    for (const e of allEdges) {
        const list = edgesByTrack.get(e.from) ?? [];
        list.push(e);
        edgesByTrack.set(e.from, list);
    }

    console.log(`[publish] ${allTracks.length} tracks, ${allTaxonomies.length} taxonomies, ${allEdges.length} edges`);

    // ── 3. Publish in batches (resumable via ledger) ──────────────────────────
    const ledger: Ledger = loadLedger(opts.ledger) ?? {
        bundleName: opts.bundleName,
        bundleSchemaId,
        batches: [],
    };
    const completedBatches = new Set(ledger.batches.map(b => b.batchIndex));

    const totalBatches = Math.ceil(allTracks.length / batchSize);
    console.log(`[publish] ${totalBatches} batches of up to ${batchSize} tracks each`);

    for (let i = 0; i < allTracks.length; i += batchSize) {
        const batchIdx = Math.floor(i / batchSize);
        if (completedBatches.has(batchIdx)) {
            console.log(`[publish] batch ${batchIdx}/${totalBatches - 1} already done, skipping`);
            continue;
        }

        const batchTracks = allTracks.slice(i, i + batchSize);
        const batchNodes: { id: string; type: string; fields: Record<string, FieldInput> }[] = [];
        const batchEdges: MbEdge[] = [];

        for (const track of batchTracks) {
            batchNodes.push({ id: track.id, type: "Track", fields: cleanFields(track.fields) });
            const taxo = taxoByTrack.get(track.id);
            if (taxo) {
                batchNodes.push({ id: taxo.id, type: "TrackTaxonomy", fields: cleanFields(taxo.fields) });
            }
            const edges = edgesByTrack.get(track.id) ?? [];
            batchEdges.push(...edges);
        }

        const batchDataset = `${opts.dataset}.batch${batchIdx}`;
        console.log(`[publish] batch ${batchIdx}/${totalBatches - 1}: ${batchTracks.length} tracks → ${batchDataset}`);

        const manifestUri = await testbed.publishBundle(opts.bundleName, batchNodes, batchEdges, batchDataset);

        ledger.batches.push({
            batchIndex: batchIdx,
            dataset: batchDataset,
            manifestUri,
            trackCount: batchTracks.length,
            publishedAt: new Date().toISOString(),
        });
        saveLedger(opts.ledger, ledger);
        console.log(`  ✓ manifest: ${manifestUri}`);
    }

    console.log("\n✅ All batches published.\n");
    console.log(`  bundle name : ${opts.bundleName}`);
    console.log(`  bundle id   : ${bundleSchemaId}`);
    console.log(`  batches     : ${ledger.batches.length}`);
    console.log(`  ledger      : ${opts.ledger}`);
    console.log("\nBuild embeddings with:\n");
    console.log(`  quickbeam build \\`);
    console.log(`    --bundle "${opts.bundleName}=${bundleSchemaId}" \\`);
    console.log(`    --root-type Track \\`);
    console.log(`    --reset\n`);
}

main().catch(err => {
    console.error("\n[publish] failed:", err);
    process.exit(1);
});
