/**
 * Smoke-test the CAR upload path end to end against a real Pinata account.
 *
 * Confirms the load-bearing assumption behind CAR uploads: that a `.car()` upload
 * recursively pins every block, so each chunk's LOCALLY-computed CID resolves on
 * its own via the gateway (we never address chunks by the directory path).
 *
 *   dotenvx run -f .env -- tsx src/test/car_smoke.ts
 *
 * Requires PINATA_JWT and PINATA_GATEWAY in env.
 */
import "dotenv/config";
import { PinataBackend } from "../providers/storage/pinata.js";

async function main(): Promise<void> {
    const jwt = process.env.PINATA_JWT;
    const gateway = process.env.PINATA_GATEWAY;
    if (!jwt || !gateway) throw new Error("Set PINATA_JWT and PINATA_GATEWAY");

    const backend = new PinataBackend(jwt, gateway);

    // A small file, a multi-block file (>1 MiB), and one with a nested Uint8Array
    // to exercise serialize()/deserialize() through the CAR.
    const items = [
        { name: "chunk-small:0", data: [{ id: "a", v: 1 }, { id: "b", v: 2 }] },
        { name: "chunk-big:1", data: Array.from({ length: 40_000 }, (_, i) => ({ id: `r${i.toString()}`, blob: "x".repeat(40) })) },
        { name: "chunk-bytes:2", data: { tag: "u8", bytes: new Uint8Array([1, 2, 3, 250, 255]) } },
    ];

    console.log(`[smoke] packing + uploading ${items.length.toString()} chunks as one CAR...`);
    const t0 = Date.now();
    const cidByName = await backend.putMany(items);
    console.log(`[smoke] uploaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    for (const { name } of items) console.log(`   ${name} -> ${cidByName[name]}`);

    console.log(`[smoke] retrieving each chunk by its standalone CID...`);
    let ok = true;
    for (const { name, data } of items) {
        const cid = cidByName[name];
        if (!cid) { console.error(`   ✘ ${name}: no CID returned`); ok = false; continue; }
        try {
            const got = await backend.get<unknown>(cid);
            const match = JSON.stringify(got) === JSON.stringify(data);
            console.log(`   ${match ? "✓" : "✘"} ${name} (${cid})`);
            if (!match) { ok = false; console.error(`     expected ${JSON.stringify(data).slice(0, 80)}\n     got      ${JSON.stringify(got).slice(0, 80)}`); }
        } catch (err) {
            ok = false;
            console.error(`   ✘ ${name} (${cid}): ${(err as Error).message}`);
        }
    }

    if (!ok) { console.error("\n[smoke] FAILED — CAR sub-blocks are not independently retrievable"); process.exit(1); }
    console.log("\n[smoke] ✅ CAR path verified: every chunk CID resolves via the gateway.");
}

main().catch((err: unknown) => { console.error("[smoke] failed:", err); process.exit(1); });
