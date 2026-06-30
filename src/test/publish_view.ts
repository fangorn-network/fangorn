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
import { type Address, type Hex } from "viem";
import "dotenv/config";

import { Fangorn } from "../fangorn.js";
import { type AppConfig, FangornConfig, SupportedNetworks } from "../config.js";
import { DataSourceRegistry } from "../registries/datasource-registry/index.js";

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

const isRid = (s: string): s is Hex => /^0x[0-9a-fA-F]{64}$/.test(s);

async function main(): Promise<void> {
    const fangorn = makeFangorn(loadConfig());
    const registry = fangorn.getSchemaRegistry();
    const owner = fangorn.getAddress() as Address;

    // schemaIds we resolve along the way — recorded in the view as a discovery hint
    // (ResolvedView.sourceSchemas) so the consumer can do per-schema queries instead
    // of scanning the whole publish history. Only NAME-resolved sources contribute;
    // a foreign --source-resource is a bare resourceId whose schema we can't know.
    const sourceSchemas = new Set<Hex>();

    // Resolve a same-owner "schemaName" or "schemaName:dataset" spec → its datasource
    // resourceId. Default dataset (no suffix) = `${schemaId}:${owner}`, matching
    // publish_bundle.ts's non-sharded default; a ":dataset" suffix matches what you
    // passed to publish_bundle.ts --dataset. Schema names never contain ':', so the
    // first colon unambiguously separates the dataset label.
    const resolveOwnedRid = async (spec: string, kind: string): Promise<Hex> => {
        const colon = spec.indexOf(":");
        const name = colon >= 0 ? spec.slice(0, colon) : spec;
        const datasetLabel = colon >= 0 ? spec.slice(colon + 1) : undefined;
        const schemaId = await registry.schemaId(name);
        if (!(await registry.schemaExists(schemaId))) {
            throw new Error(`${kind} "${name}" is not registered — publish it first.`);
        }
        sourceSchemas.add(schemaId);
        const ds = datasetLabel ?? `${schemaId}:${owner}`;
        const rid = DataSourceRegistry.resourceId(owner, schemaId, ds);
        console.log(`[publish-view]   ${kind} "${name}"${datasetLabel ? ` dataset="${datasetLabel}"` : " (default dataset)"} → resourceId ${rid}`);
        return rid;
    };

    // ── 1. assemble sources + linksets (owned names resolved, raw rids validated) ──
    console.log(`[publish-view] resolving sources for view "${opts.name}"...`);
    const sources: Hex[] = [];
    for (const name of opts.sourceBundle) sources.push(await resolveOwnedRid(name, "source-bundle"));
    for (const r of opts.sourceResource) {
        if (!isRid(r)) throw new Error(`--source-resource "${r}" is not a 32-byte 0x… resourceId`);
        sources.push(r);
        console.log(`[publish-view]   source-resource (foreign) → ${r}`);
    }
    if (sources.length === 0) throw new Error("a view needs at least one source — pass --source-bundle and/or --source-resource");

    const linksets: Hex[] = [];
    for (const name of opts.linksetName) linksets.push(await resolveOwnedRid(name, "linkset-name"));
    for (const r of opts.linksetResource) {
        if (!isRid(r)) throw new Error(`--linkset-resource "${r}" is not a 32-byte 0x… resourceId`);
        linksets.push(r);
    }

    let trust: Record<string, unknown> | undefined;
    if (opts.trust) {
        try { trust = JSON.parse(opts.trust) as Record<string, unknown>; }
        catch { throw new Error(`--trust is not valid JSON: ${opts.trust}`); }
    }

    // ── 2. register the view (idempotent by name) ─────────────────────────────
    let viewId: Hex;
    const computedViewId = await registry.schemaId(opts.name);
    const exists = await registry.schemaExists(computedViewId);
    if (exists) {
        viewId = computedViewId;
        console.log(`[publish-view] view "${opts.name}" already registered → ${viewId}`);
        console.log(`[publish-view]   (registration is idempotent by name; to CHANGE sources, bump the view name/version)`);
    } else if (opts.skipRegister) {
        throw new Error(`--skip-register but view "${opts.name}" is not registered`);
    } else {
        const reg = await fangorn.schema.register({ kind: "view", name: opts.name, view: { sources, linksets, trust, sourceSchemas: [...sourceSchemas] } });
        viewId = reg.schemaId;
        const v = reg as Extract<typeof reg, { kind: "view" }>;
        console.log(`[publish-view] registered view "${opts.name}" → ${viewId}`);
        console.log(`[publish-view]   sources : ${v.view.sources.join(", ")}`);
        if (v.view.linksets.length) console.log(`[publish-view]   linksets: ${v.view.linksets.join(", ")}`);
    }

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
