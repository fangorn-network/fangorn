/**
 * Register + publish a Composed VIEW to Fangorn (the companion to publish_bundle.ts).
 *
 * A view fuses several already-published datasources on global identity. Its
 * `sources` are resourceIds = keccak(owner, bundleSchemaId, datasetName). This
 * script resolves them two ways so the same command covers the single-owner case
 * AND the cross-publisher case the view exists for:
 *
 *   --source-bundle <name>     a bundle YOU published (same owner). Resolved to its
 *                              resourceId via the non-sharded default datasetName
 *                              publish_bundle.ts uses (`${schemaId}:${owner}`).
 *   --source-resource <0xRid>  a raw resourceId — a FOREIGN publisher's datasource,
 *                              or any custom/sharded datasetName you resolved yourself.
 *
 * Linksets (asserted cross-edges) attach the same way: --linkset-name / --linkset-resource.
 *
 *   pnpm dotenvx run -f .env -- tsx src/test/publish_view.ts \
 *     --name fangorn.places.localview.v1 \
 *     --source-bundle fangorn.places.placecore.v1 \
 *     --source-bundle fangorn.places.eventcore.v1 \
 *     --source-resource 0x<foreignRid>
 *
 * Requires the same env/config as publish_bundle.ts: DELEGATOR_ETH_PRIVATE_KEY,
 * PINATA_JWT, PINATA_GATEWAY, CHAIN_NAME[, RPC_URL] — or ~/.fangorn/config.json.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { program } from "commander";
import { type Hex } from "viem";
import "dotenv/config";

import { Fangorn } from "../fangorn.js";
import { type AppConfig, FangornConfig, SupportedNetworks } from "../config.js";
import { resolveViewSources, ensureView } from "../cli/bundle-source.js";

// ── config (env-first, then ~/.fangorn/config.json) — mirrors publish_bundle.ts ──
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
    if (rpcOverride) console.log(`[publish-view] RPC override: ${rpcOverride}`);
    return Fangorn.create({
        privateKey: c.privateKey,
        storage: { pinata: { jwt: c.pinataJwt, gateway: c.pinataGateway } },
        domain: "localhost",
        config: cfg,
        agentConfig: { privateKey: c.privateKey, pinataJwt: c.pinataJwt },
    });
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const collect = (val: string, prev: string[]): string[] => { prev.push(val); return prev; };
program
    .requiredOption("--name <viewName>", "View schema name to register + publish")
    .option("--source-bundle <name[:dataset]>", "Same-owner source bundle. Just the name uses the default dataset; append ':<dataset>' to target a --dataset datasource (e.g. ...eventcore.v1:tribe). Repeatable.", collect, [])
    .option("--source-resource <0xRid>", "Raw source resourceId — only needed for a FOREIGN publisher's datasource (repeatable)", collect, [])
    .option("--linkset-name <name[:dataset]>", "Same-owner linkset, same name[:dataset] form as --source-bundle (repeatable)", collect, [])
    .option("--linkset-resource <0xRid>", "Raw linkset resourceId for a foreign linkset (repeatable)", collect, [])
    .option("--trust <json>", "Trust policy JSON for the view (opaque until the trust phase)")
    .option("--view-dataset <name>", "datasetName for the view's OWN datasource publish (default `${viewSchemaId}:${owner}`)")
    .option("--skip-register", "Don't register; resolve an existing view id and just (re)publish its manifest", false)
    .parse();

const opts = program.opts<{
    name: string;
    sourceBundle: string[]; sourceResource: string[];
    linksetName: string[]; linksetResource: string[];
    trust?: string; viewDataset?: string; skipRegister: boolean;
}>();

async function main(): Promise<void> {
    const fangorn = makeFangorn(loadConfig());

    // ── 1. assemble sources + linksets (owned names resolved, raw rids validated) ──
    // Shared with `fangorn commit --view` (src/cli/bundle-source.ts) so the two can't
    // drift: same name[:dataset] resolution, same foreign-resourceId validation, same
    // sourceSchemas discovery hint recorded in the view.
    console.log(`[publish-view] resolving sources for view "${opts.name}"...`);
    const resolved = await resolveViewSources(fangorn, {
        sourceBundle: opts.sourceBundle,
        sourceResource: opts.sourceResource,
        linksetName: opts.linksetName,
        linksetResource: opts.linksetResource,
        trust: opts.trust,
        log: (m) => { console.log(`[publish-view]   ${m}`); },
    });
    const { sources, linksets } = resolved;

    // ── 2. register the view (idempotent by name) ─────────────────────────────
    const viewId = await ensureView(fangorn, opts.name, resolved, opts.skipRegister, (m) => { console.log(`[publish-view] ${m}`); });

    // ── 3. publish the view's datasource manifest ─────────────────────────────
    console.log(`[publish-view] publishing view manifest...`);
    const res = await fangorn.publisher.publishView({ viewName: opts.name, datasetName: opts.viewDataset });

    console.log(`\n✅ View published.\n`);
    console.log(`  view name   : ${opts.name}`);
    console.log(`  view id     : ${viewId}`);
    console.log(`  sources     : ${sources.length}${linksets.length ? ` + ${linksets.length.toString()} linkset(s)` : ""}`);
    console.log(`  manifest cid: ${res.manifestUri}`);
    console.log("\nBuild the fused shard with:\n");
    console.log(`  quickbeam build --view "${opts.name}=${viewId}" --root-profile business --root-profile localevent --reset\n`);
}

main().catch((err: unknown) => { console.error("\n[publish-view] failed:", err); process.exit(1); });
