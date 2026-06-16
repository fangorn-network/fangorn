//
// Copyright (c) Fangorn LLC and contributors. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.
//

/**
 * Test-data setup for the Python embeddings builder (embeddings.py, bundle mode).
 *
 * Registers a minimalist music bundle (Track + Artist) and publishes a handful
 * of joined records as a single v3 bundle commitment. This is exactly the shape
 * embeddings.py consumes when run as:
 *
 *   python embeddings.py --bundle "<bundleName>=<bundleSchemaId>" --root-type Track --reset
 *
 * The builder walks `performed_by` edges from each Track (root) node and flattens
 * the Artist neighbour's fields in, then embeds "Title: <title>. Tags: <...>" and
 * indexes fields.title / fields.byArtist. We therefore put `title` + `byArtist`
 * directly on the Track and add a couple of categorical fields for the Tags text.
 *
 * Run it (loads .env the same way the e2e suite does):
 *
 *   pnpm dotenvx run -f .env -- tsx src/test/setup-embeddings-testdata.ts
 *   # or: pnpm setup:embeddings
 *
 * On success it prints the --bundle argument to paste into the builder.
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { TestBed } from "./testbed.js";
import { BundleInput, SchemaDefinition } from "../roles/schema/types.js";
import { FieldInput } from "../roles/publisher/types.js";

// Ledger of what each run created, so the cleanup script can unpin it later.
export const LEDGER_FILE = process.env.EMBEDDINGS_TESTDATA_LEDGER ?? "tmp/embeddings-testdata.json";

export interface LedgerEntry {
    bundleName: string;
    bundleSchemaId: Hex;
    datasetName: string;
    manifestUri: string;
    createdAt: string;
}

function appendLedger(entry: LedgerEntry): void {
    let entries: LedgerEntry[] = [];
    if (existsSync(LEDGER_FILE)) {
        try {
            entries = JSON.parse(readFileSync(LEDGER_FILE, "utf8")) as LedgerEntry[];
        } catch {
            entries = [];
        }
    }
    entries.push(entry);
    mkdirSync(dirname(LEDGER_FILE), { recursive: true });
    writeFileSync(LEDGER_FILE, JSON.stringify(entries, null, 2));
}

// ── env (mirrors src/e2e.test.ts, with fallbacks to this repo's .env names) ──
const SK = process.env.DELEGATOR_ETH_PRIVATE_KEY as Hex;
const RPC_URL = process.env.RPC_URL ?? process.env.CHAIN_RPC_URL ?? "https://sepolia-rollup.arbitrum.io/rpc";
const WORKER_URL = process.env.WORKER_URL ?? "http://localhost:8787";

const SETTLEMENT_REGISTRY_ADDRESS = process.env.SETTLEMENT_REGISTRY_ADDRESS as Address;
const DATA_SOURCE_REGISTRY_ADDRESS = process.env.DATA_SOURCE_REGISTRY_ADDRESS as Address;
const SCHEMA_REGISTRY_ADDRESS = process.env.SCHEMA_REGISTRY_ADDRESS as Address;

const USDC_ADDRESS = (process.env.USDC_ADDRESS ?? process.env.USDC_CONTRACT_ADDRESS ?? "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d") as Address;
const USDC_DOMAIN = "USD Coin";

const CHAIN = arbitrumSepolia;

// ── minimalist node schemas ──────────────────────────────────────────────────
// Track carries title + byArtist (both indexed by the builder) plus two small
// categorical fields that infer_roles will treat as tags for the embed text.
const TRACK_SCHEMA: SchemaDefinition = {
    title: { "@type": "string" },
    byArtist: { "@type": "string" },
    genre: { "@type": "string" },
    mood: { "@type": "string" },
};

// Artist is the 1-hop neighbour; its fields get flattened into the Track.
const ARTIST_SCHEMA: SchemaDefinition = {
    name: { "@type": "string" },
    country: { "@type": "string" },
};

// ── a few entries — deliberately tiny ────────────────────────────────────────
interface Node { id: string; type: string; fields: Record<string, FieldInput> }
interface Edge { rel: string; from: string; to: string }

const NODES: Node[] = [
    { id: "artist-aurora", type: "Artist", fields: { name: "Aurora Skies", country: "Norway" } },
    { id: "artist-monsoon", type: "Artist", fields: { name: "Monsoon Collective", country: "India" } },

    { id: "track-northern-lights", type: "Track", fields: { title: "Northern Lights", byArtist: "Aurora Skies", genre: "ambient", mood: "calm" } },
    { id: "track-glacier", type: "Track", fields: { title: "Glacier Drift", byArtist: "Aurora Skies", genre: "ambient", mood: "cold" } },
    { id: "track-monsoon-rain", type: "Track", fields: { title: "Monsoon Rain", byArtist: "Monsoon Collective", genre: "world", mood: "warm" } },
    { id: "track-tabla-pulse", type: "Track", fields: { title: "Tabla Pulse", byArtist: "Monsoon Collective", genre: "world", mood: "energetic" } },
];

const EDGES: Edge[] = [
    { rel: "performed_by", from: "track-northern-lights", to: "artist-aurora" },
    { rel: "performed_by", from: "track-glacier", to: "artist-aurora" },
    { rel: "performed_by", from: "track-monsoon-rain", to: "artist-monsoon" },
    { rel: "performed_by", from: "track-tabla-pulse", to: "artist-monsoon" },
];

function makeWallet(key: Hex) {
    return createWalletClient({
        account: privateKeyToAccount(key),
        chain: CHAIN,
        transport: http(RPC_URL),
    });
}

function requireEnv() {
    const missing: string[] = [];
    if (SK === "0x") missing.push("DELEGATOR_ETH_PRIVATE_KEY");
    if (DATA_SOURCE_REGISTRY_ADDRESS === "0x") missing.push("DATA_SOURCE_REGISTRY_ADDRESS");
    if (SCHEMA_REGISTRY_ADDRESS === "0x") missing.push("SCHEMA_REGISTRY_ADDRESS");
    if (!process.env.PINATA_JWT) missing.push("PINATA_JWT");
    if (missing.length) {
        throw new Error(
            `Missing required env vars: ${missing.join(", ")}.\n` +
            `Run via: pnpm dotenvx run -f .env -- tsx src/test/setup-embeddings-testdata.ts`,
        );
    }
}

async function main() {
    requireEnv();

    const testbed = TestBed.init(
        makeWallet(SK),
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

    const suffix = `${Date.now().toString()}.${Math.random().toString(36).substring(2, 5)}`;
    const trackSchema = `fangorn.track.${suffix}`;
    const artistSchema = `fangorn.artist.${suffix}`;
    const bundleName = `fangorn.music.bundle.${suffix}`;
    const datasetName = `ds.embeddings.${suffix}`;

    console.log("[setup] registering node schemas ...");
    await testbed.registerSchema(trackSchema, TRACK_SCHEMA);
    await testbed.registerSchema(artistSchema, ARTIST_SCHEMA);

    console.log("[setup] registering bundle shape ...");
    const bundle: BundleInput = {
        nodes: { Track: trackSchema, Artist: artistSchema },
        edges: [{ rel: "performed_by", from: "Track", to: "Artist", min: 1, max: 1 }],
    };
    const bundleSchemaId = await testbed.registerBundle(bundleName, bundle);

    console.log(`[setup] publishing ${NODES.length.toString()} nodes / ${EDGES.length.toString()} edges as one v3 bundle ...`);
    const manifestUri = await testbed.publishBundle(bundleName, NODES, EDGES, datasetName);

    appendLedger({ bundleName, bundleSchemaId, datasetName, manifestUri, createdAt: new Date().toISOString() });

    console.log("\n✅ Test data published.\n");
    console.log(`  bundle name : ${bundleName}`);
    console.log(`  bundle id   : ${bundleSchemaId}`);
    console.log(`  dataset     : ${datasetName}`);
    console.log(`  manifest cid: ${manifestUri}`);
    console.log("\nFeed the embeddings builder with:\n");
    console.log(`  python embeddings.py \\`);
    console.log(`    --bundle "${bundleName}=${bundleSchemaId}" \\`);
    console.log(`    --root-type Track \\`);
    console.log(`    --reset\n`);
    console.log(`Recorded in ${LEDGER_FILE} — unpin later with: pnpm cleanup:embeddings\n`);
}

main().catch((err: unknown) => {
    console.error("\n[setup] failed:", err);
    process.exit(1);
});
