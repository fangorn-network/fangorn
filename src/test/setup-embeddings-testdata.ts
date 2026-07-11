//
// Copyright (c) Fangorn LLC and contributors. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.
//

/**
 * Test-data setup for the Python embeddings builder (quickbeam), owner+namespace model.
 *
 * Uploads a handful of joined Track/Artist vertices+edges into a namespace as a
 * single batch commit. This is exactly the shape quickbeam's `fangorn read`
 * consumer expects:
 *
 *   fangorn read <namespace> --owner <address> --pretty
 *   python -m quickbeam build --source <address>:<namespace>
 *
 * Run it (loads .env the same way the e2e suite does):
 *
 *   pnpm dotenvx run -f .env -- tsx src/test/setup-embeddings-testdata.ts
 *   # or: pnpm setup:embeddings
 *
 * On success it prints the --source argument to paste into the builder.
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { type Hex } from "viem";
import { TestBed } from "./testbed.js";

// Ledger of what each run created, so the cleanup script can unpin it later.
export const LEDGER_FILE = process.env.EMBEDDINGS_TESTDATA_LEDGER ?? "tmp/embeddings-testdata.json";

export interface LedgerEntry {
    owner: string;
    namespace: string;
    commitCid: string;
    vertexCids: string[];
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

// ── env ──────────────────────────────────────────────────────────────────────
const SK = process.env.ETH_PRIVATE_KEY as Hex;

// ── a few entries — deliberately tiny, mirroring the shape a real namespace has:
// Track vertices carry `title`/`byArtist` directly (both indexed by the builder)
// plus a couple of categorical fields that infer_roles will treat as tags, and a
// `performed_by` edge to the Artist vertex whose fields get flattened in. ──────
const VERTICES: { id: string; tag: string; payload: any }[] = [
    { id: "artist-aurora", tag: "artist", payload: { name: "Aurora Skies", country: "Norway" } },
    { id: "artist-monsoon", tag: "artist", payload: { name: "Monsoon Collective", country: "India" } },

    { id: "track-northern-lights", tag: "track", payload: { title: "Northern Lights", byArtist: "Aurora Skies", genre: "ambient", mood: "calm" } },
    { id: "track-glacier", tag: "track", payload: { title: "Glacier Drift", byArtist: "Aurora Skies", genre: "ambient", mood: "cold" } },
    { id: "track-monsoon-rain", tag: "track", payload: { title: "Monsoon Rain", byArtist: "Monsoon Collective", genre: "world", mood: "warm" } },
    { id: "track-tabla-pulse", tag: "track", payload: { title: "Tabla Pulse", byArtist: "Monsoon Collective", genre: "world", mood: "energetic" } },
];

const EDGES: { rel: string; from: string; to: string }[] = [
    { rel: "performed_by", from: "track-northern-lights", to: "artist-aurora" },
    { rel: "performed_by", from: "track-glacier", to: "artist-aurora" },
    { rel: "performed_by", from: "track-monsoon-rain", to: "artist-monsoon" },
    { rel: "performed_by", from: "track-tabla-pulse", to: "artist-monsoon" },
];

function requireEnv() {
    const missing: string[] = [];
    if (!SK) missing.push("ETH_PRIVATE_KEY");
    if (!process.env.PINATA_JWT) missing.push("PINATA_JWT");
    if (!process.env.PINATA_GATEWAY) missing.push("PINATA_GATEWAY");
    if (missing.length) {
        throw new Error(
            `Missing required env vars: ${missing.join(", ")}.\n` +
            `Run via: pnpm dotenvx run -f .env -- tsx src/test/setup-embeddings-testdata.ts`,
        );
    }
}

async function main() {
    requireEnv();

    const testbed = TestBed.init([SK]);
    const owner = testbed.getFangorn(0).getAddress();

    console.log("[setup] ensuring publisher is registered...");
    await testbed.register(0);

    const namespace = `fangorn.music.${Date.now().toString()}`;
    console.log(`[setup] initializing namespace "${namespace}"...`);
    await testbed.initRepo(0, namespace);

    console.log(`[setup] uploading ${VERTICES.length.toString()} vertices / ${EDGES.length.toString()} edges as one batch commit...`);
    const result = await testbed.uploadBatch(0, namespace, VERTICES, EDGES);

    appendLedger({
        owner,
        namespace,
        commitCid: result.commitCid,
        vertexCids: Object.values(result.vertexCids),
        createdAt: new Date().toISOString(),
    });

    console.log("\n✅ Test data published.\n");
    console.log(`  owner       : ${owner}`);
    console.log(`  namespace   : ${namespace}`);
    console.log(`  commit cid  : ${result.commitCid}`);
    console.log("\nFeed the embeddings builder with:\n");
    console.log(`  quickbeam build --source ${owner}:${namespace}\n`);
    console.log(`Recorded in ${LEDGER_FILE} — unpin later with: pnpm cleanup:embeddings\n`);
}

main().catch((err: unknown) => {
    console.error("\n[setup] failed:", err);
    process.exit(1);
});
