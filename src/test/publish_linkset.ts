/**
 * Register + publish a LINKSET to Fangorn (the third sibling of publish_bundle.ts
 * and publish_view.ts).
 *
 * A linkset is a published list of asserted cross-edges `{ from, rel, to }` — the
 * EXPLICIT way to fuse two datasources that share no identity alias (e.g. a Google
 * Places bar `gplace:…` and the same bar in OSM `osm:…`). A `sameAs` edge tells a
 * Composed View to collapse the two endpoints into one fused entity. Endpoints are
 * Entity URIs (`fangorn:<resourceId>/<localId>`) or namespaced aliases (`gplace:…`).
 *
 * Generate the links first (e.g. `quickbeam data linkgen` writes a JSON array of
 * {from, rel, to, confidence?, evidence?}), then:
 *
 *   pnpm dotenvx run -f .env -- tsx src/test/publish_linkset.ts \
 *     --name eagleriver.sond3r.com.links.placesXosm.v1 \
 *     --links ~/fangorn/embeddings/biz_links.json
 *
 * Then add it to the View:  publish_view.ts --linkset-name <that name>
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
import { type LinkRecord } from "../roles/schema/types.js";

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
    if (rpcOverride) console.log(`[publish-linkset] RPC override: ${rpcOverride}`);
    return Fangorn.create({
        privateKey: c.privateKey,
        storage: { pinata: { jwt: c.pinataJwt, gateway: c.pinataGateway } },
        domain: "localhost",
        config: cfg,
        agentConfig: { privateKey: c.privateKey, pinataJwt: c.pinataJwt },
    });
}

// ── CLI ───────────────────────────────────────────────────────────────────────
program
    .requiredOption("--name <linksetName>", "Linkset schema name to register + publish")
    .requiredOption("--links <path>", "JSON file: array of { from, rel, to, confidence?, evidence? } (e.g. from `quickbeam data linkgen`)")
    .option("--rels <csv>", "Allowed relations (comma-separated). Default: inferred from the links file.")
    .option("--dataset <name>", "datasetName for the linkset's datasource (default `${schemaId}:${owner}`)")
    .option("--skip-register", "Don't register the linkset schema; resolve an existing id and just (re)publish", false)
    .parse();

const opts = program.opts<{ name: string; links: string; rels?: string; dataset?: string; skipRegister: boolean }>();

async function main(): Promise<void> {
    if (!existsSync(opts.links)) throw new Error(`--links file not found: ${opts.links}`);
    const links = JSON.parse(readFileSync(opts.links, "utf8")) as LinkRecord[];
    if (!Array.isArray(links) || links.length === 0) throw new Error(`${opts.links} is not a non-empty JSON array of links`);

    // Allowlist: explicit --rels, else the distinct relations present in the file.
    const rels = opts.rels
        ? opts.rels.split(",").map(r => r.trim()).filter(Boolean)
        : [...new Set(links.map(l => l.rel))];

    const fangorn = makeFangorn(loadConfig());
    const registry = fangorn.getSchemaRegistry();
    const owner = fangorn.getAddress() as Address;

    console.log(`[publish-linkset] "${opts.name}": ${links.length} link(s), relations [${rels.join(", ")}]`);

    // ── 1. register the linkset schema (idempotent by name) ───────────────────
    let linksetId: Hex;
    const computedId = await registry.schemaId(opts.name);
    if (await registry.schemaExists(computedId)) {
        linksetId = computedId;
        console.log(`[publish-linkset] linkset "${opts.name}" already registered → ${linksetId}`);
    } else if (opts.skipRegister) {
        throw new Error(`--skip-register but linkset "${opts.name}" is not registered`);
    } else {
        const reg = await fangorn.schema.register({ kind: "linkset", name: opts.name, linkset: { rels } });
        linksetId = reg.schemaId;
        console.log(`[publish-linkset] registered linkset "${opts.name}" → ${linksetId}`);
    }

    // ── 2. publish the links as the linkset's datasource ──────────────────────
    const res = await fangorn.publisher.publishLinkset({ linksetName: opts.name, links, datasetName: opts.dataset });

    const ds = opts.dataset ?? `${linksetId}:${owner}`;
    const resourceId = DataSourceRegistry.resourceId(owner, linksetId, ds);
    console.log(`\n✅ Linkset published.\n`);
    console.log(`  linkset name : ${opts.name}`);
    console.log(`  linkset id   : ${linksetId}`);
    console.log(`  links        : ${links.length}`);
    console.log(`  dataset      : ${opts.dataset ?? `${linksetId}:${owner} (default)`}`);
    console.log(`  resourceId   : ${resourceId}`);
    console.log(`  manifest cid : ${res.manifestUri}`);
    console.log(`\nAttach it to a View with publish_view.ts:`);
    console.log(`  --linkset-name ${opts.name}${opts.dataset ? `:${opts.dataset}` : ""}\n`);
}

main().catch((err: unknown) => { console.error("\n[publish-linkset] failed:", err); process.exit(1); });
