//
// Copyright (c) Fangorn LLC and contributors. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.
//

/**
 * Cleanup counterpart to setup-embeddings-testdata.ts.
 *
 * Reads the ledger written by the setup script and best-effort unpins, for
 * every recorded run, the vertex CIDs it uploaded from Pinata. On-chain state
 * (the namespace root) is not rewound — only `fangorn.reset()` (destructive,
 * wipes ALL namespaces for that owner) can do that; this script only reclaims
 * the IPFS pins for the vertex payloads themselves. Intermediate Pail shard
 * blocks created alongside them are not individually tracked and are left
 * pinned (they're small, content-addressed, and shared across commits).
 *
 * Run it:
 *
 *   pnpm cleanup:embeddings
 *   # or: pnpm dotenvx run -f .env -- tsx src/test/cleanup-embeddings-testdata.ts
 *
 * The ledger is deleted only if every CID unpinned cleanly.
 */

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { LEDGER_FILE, type LedgerEntry } from "./setup-embeddings-testdata.js";

// will fail if the jwt is not provided
const PINATA_JWT = process.env.PINATA_JWT ?? "";

async function unpinFromPinata(cid: string): Promise<boolean> {
    try {
        const response = await fetch(`https://api.pinata.cloud/pinning/unpin/${cid}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${PINATA_JWT}` },
        });
        if (response.ok) {
            console.log(`  ✓ unpinned ${cid}`);
            return true;
        }
        // Already gone (404 / not pinned) is fine for cleanup purposes.
        if (response.status === 404) {
            console.log(`  - ${cid} not pinned (already gone)`);
            return true;
        }
        console.warn(`  ✗ ${cid}: ${response.status.toString()} ${response.statusText}`);
        return false;
    } catch (err) {
        console.warn(`  ✗ ${cid}: request failed`, err);
        return false;
    }
}

async function main() {
    if (!PINATA_JWT) throw new Error("PINATA_JWT is required to unpin.");
    if (!existsSync(LEDGER_FILE)) {
        console.log(`[cleanup] no ledger at ${LEDGER_FILE} — nothing to clean up.`);
        return;
    }

    const entries = JSON.parse(readFileSync(LEDGER_FILE, "utf8")) as LedgerEntry[];
    if (entries.length === 0) {
        console.log("[cleanup] ledger is empty — nothing to clean up.");
        return;
    }

    let allOk = true;
    for (const entry of entries) {
        console.log(`\n[cleanup] ${entry.owner}/${entry.namespace} (commit ${entry.commitCid})`);
        for (const cid of entry.vertexCids) {
            const ok = await unpinFromPinata(cid);
            allOk = allOk && ok;
        }
    }

    if (allOk) {
        writeFileSync(LEDGER_FILE, "[]");
        console.log(`\n✅ Cleanup complete. Cleared ${LEDGER_FILE}.`);
    } else {
        console.log(`\n⚠️  Cleanup finished with some failures — ledger left in place (${LEDGER_FILE}) so you can re-run.`);
    }
}

main().catch((err: unknown) => {
    console.error("\n[cleanup] failed:", err);
    process.exit(1);
});
