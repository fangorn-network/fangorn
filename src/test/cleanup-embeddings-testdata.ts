//
// Copyright (c) Fangorn LLC and contributors. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.
//

/**
 * Cleanup counterpart to setup-embeddings-testdata.ts.
 *
 * Reads the ledger written by the setup script and unpins, for every recorded
 * run, the v3 bundle manifest plus all of its node + edge chunk CIDs from
 * Pinata. Schema registrations are on-chain and cannot be removed; this only
 * reclaims the IPFS pins the test data created.
 *
 * Run it:
 *
 *   pnpm cleanup:embeddings
 *   # or: pnpm dotenvx run -f .env -- tsx src/test/cleanup-embeddings-testdata.ts
 *
 * The ledger is deleted only if every CID unpinned cleanly.
 */

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { TestBed } from "./testbed.js";
import { LEDGER_FILE, type LedgerEntry } from "./setup-embeddings-testdata.js";

const SK = process.env.DELEGATOR_ETH_PRIVATE_KEY as Hex;
const RPC_URL = process.env.RPC_URL ?? process.env.CHAIN_RPC_URL ?? "https://sepolia-rollup.arbitrum.io/rpc";
const WORKER_URL = process.env.WORKER_URL ?? "http://localhost:8787";
const PINATA_JWT = process.env.PINATA_JWT;

const SETTLEMENT_REGISTRY_ADDRESS = process.env.SETTLEMENT_REGISTRY_ADDRESS as Address;
const DATA_SOURCE_REGISTRY_ADDRESS = process.env.DATA_SOURCE_REGISTRY_ADDRESS as Address;
const SCHEMA_REGISTRY_ADDRESS = process.env.SCHEMA_REGISTRY_ADDRESS as Address;
const USDC_ADDRESS = (process.env.USDC_ADDRESS ?? process.env.USDC_CONTRACT_ADDRESS ?? "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d") as Address;
const USDC_DOMAIN = "USD Coin";

const CHAIN = arbitrumSepolia;

function makeWallet(key: Hex) {
    return createWalletClient({
        account: privateKeyToAccount(key),
        chain: CHAIN,
        transport: http(RPC_URL),
    });
}

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
        console.warn(`  ✗ ${cid}: ${response.status} ${response.statusText}`);
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
    const publisher = testbed.getDelegatorFangorn().publisher;

    let allOk = true;
    for (const entry of entries) {
        console.log(`\n[cleanup] ${entry.bundleName} (manifest ${entry.manifestUri})`);

        // Collect the chunk CIDs from the manifest before unpinning the manifest itself.
        const cids: string[] = [];
        try {
            const manifest = await publisher.getBundleManifestByCid(entry.manifestUri);
            if (manifest) {
                for (const c of manifest.nodeChunks) cids.push(c.dataCid);
                if (manifest.edgeChunk?.dataCid) cids.push(manifest.edgeChunk.dataCid);
            } else {
                console.warn("  (could not read manifest — unpinning manifest CID only)");
            }
        } catch (err) {
            console.warn("  (failed to read manifest — unpinning manifest CID only)", err);
        }
        cids.push(entry.manifestUri);

        for (const cid of cids) {
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

main().catch((err) => {
    console.error("\n[cleanup] failed:", err);
    process.exit(1);
});
