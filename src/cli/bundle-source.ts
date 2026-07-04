/**
 * Bundle/view data-shaping helpers shared by the git-native CLI
 * (`fangorn commit --bundle/--view`) and the legacy publish scripts
 * (`src/test/publish_bundle.ts`, `publish_view.ts`).
 *
 * This is the "data shaping" half of the publish split (see
 * `docs/archive/GIT_NATIVE_IMPLEMENTATION_PLAN.md` → bundle/view commits): reading
 * `quickbeam data schemagen` output, conforming fields to the registered schema,
 * discovering node/edge files, and idempotent schema registration. The "publish
 * mechanics" half (build tree → wrap commit → push) lives in the publisher role
 * and the CLI. Long-term this module migrates into quickbeam as `quickbeam data
 * publish`; keeping it here first lets the CLI and scripts share ONE implementation
 * so they can't drift.
 */

import { existsSync, readFileSync, readdirSync, createReadStream } from "node:fs";
import { join } from "node:path";
import { type Hex } from "viem";

import { type Fangorn } from "../fangorn.js";
import { type BundleInput, type NodeIdentity, type SchemaDefinition } from "../roles/schema/types.js";
import { type FieldInput } from "../roles/publisher/types.js";

// ── data shapes (schemagen output + the streamed node/edge records) ────────────
export interface NodeSchemaFile { name: string; definition: SchemaDefinition; identity?: NodeIdentity }
export interface BundleSchemaFile { name: string; kind: "bundle"; bundle: BundleInput }
export interface ConsolidatedSchemas { schemas: NodeSchemaFile[]; bundle: BundleSchemaFile }
export interface MbNode { name: string; fields: Record<string, unknown> }
export interface MbEdge { rel: string; from: string; to: string; fromType?: string; toType?: string }

// Optional explicit node-type → filename-stem overrides. NOT required: the
// resolver discovers files from disk by each node's `entityType`, so this works
// for ANY schemagen output. These entries just pin the MusicBrainz stems.
const TYPE_FILE: Record<string, string> = {
    Artist: "artists", Recording: "recordings", ReleaseGroup: "releasegroups", Release: "releases", Work: "works",
};
const STEM_TYPE: Record<string, string> = Object.fromEntries(Object.entries(TYPE_FILE).map(([t, f]) => [f, t]));

/**
 * Stream the top-level elements of a JSON array, robust to formatting: works
 * whether each record is on its own line (the JsonArrayWriter convention) OR the
 * file is pretty-printed with records spanning many lines. Scans char-by-char
 * tracking string/escape state and brace depth, yielding each complete top-level
 * object — so a reformatted file can't silently stream zero records.
 */
export async function* streamJsonArray<T>(path: string, limit = 0): AsyncIterable<T> {
    const stream = createReadStream(path, { encoding: "utf8", highWaterMark: 1 << 20 });
    let n = 0, depth = 0;
    let inString = false, escape = false, started = false, capturing = false, buf = "";
    for await (const chunk of stream as AsyncIterable<string>) {
        for (const ch of chunk) {
            if (capturing) buf += ch;
            if (inString) {
                if (escape) escape = false;
                else if (ch === "\\") escape = true;
                else if (ch === "\"") inString = false;
                continue;
            }
            if (ch === "\"") { inString = true; continue; }
            if (ch === "{" || ch === "[") {
                if (!started) { started = true; continue; }   // the outer array container
                if (!capturing) { capturing = true; buf = ch; } // begin a top-level element
                depth++;
            } else if (ch === "}" || ch === "]") {
                if (!capturing) continue;                       // outer ']' / whitespace
                depth--;
                if (depth === 0) {
                    capturing = false;
                    try {
                        const v = JSON.parse(buf) as T;
                        yield v;
                        if (limit && ++n >= limit) { stream.destroy(); return; }
                    } catch { /* skip a malformed element, keep streaming */ }
                    buf = "";
                }
            }
        }
    }
}

// ── volume file discovery (volume 0 = all volumes) ─────────────────────────────
function volumePrefixMatch(file: string, volume: number): { match: boolean; prefix: string } {
    if (volume === 0) {
        const m = /^volume_\d+_/.exec(file);
        return { match: m !== null, prefix: m ? m[0] : "" };
    }
    const prefix = `volume_${volume.toString()}_`;
    return { match: file.startsWith(prefix), prefix };
}

/**
 * Discover each node file from disk and key it by the `entityType` its records
 * carry. Dataset-agnostic: the same resolver handles MusicBrainz, places, events.
 */
export async function makeTypeResolver(inputDir: string, volume: number): Promise<(type: string) => string | undefined> {
    const discovered = new Map<string, string>();
    for (const f of readdirSync(inputDir)) {
        const { match, prefix } = volumePrefixMatch(f, volume);
        if (!match || !f.endsWith(".json") || f.endsWith("_edges.json")) continue;
        const path = join(inputDir, f);
        let type: string | undefined;
        for await (const node of streamJsonArray<MbNode>(path, 1)) {
            const t = (node.fields as Record<string, unknown> | undefined)?.entityType;
            if (typeof t === "string") type = t;
        }
        if (!type) {
            const stem = f.slice(prefix.length, -5);
            type = STEM_TYPE[stem] ?? stem.split("_").map(s => s.charAt(0).toUpperCase() + s.slice(1)).join("_");
        }
        if (!discovered.has(type)) discovered.set(type, path);
    }
    return (type: string) => {
        if (volume !== 0) {
            const explicit = TYPE_FILE[type];
            if (explicit) { const p = join(inputDir, `volume_${volume.toString()}_${explicit}.json`); if (existsSync(p)) return p; }
        }
        return discovered.get(type);
    };
}

/** Edge files for the run: any `volume_<n>_*edges.json` (volume 0 = every volume). */
export function edgeFilesFor(inputDir: string, volume: number): string[] {
    const prefix = volume === 0 ? /^volume_\d+_/ : new RegExp(`^volume_${volume.toString()}_`);
    return readdirSync(inputDir)
        .filter(f => f.endsWith("edges.json") && prefix.test(f))
        .sort()
        .map(f => join(inputDir, f));
}

// ── schema conformance (schemas inferred from a sample → over-constrained) ─────
function defaultFor(b: string): FieldInput { return b === "number" ? 0 : b === "boolean" ? false : b === "array" ? [] : b === "object" ? {} : ""; }
function coerce(v: unknown, b: string, nul: boolean): FieldInput {
    if (v === undefined || v === null) return nul ? null : defaultFor(b);
    switch (b) {
        case "string": return typeof v === "string" ? v : (typeof v === "number" || typeof v === "boolean") ? String(v) : JSON.stringify(v);
        case "number": if (typeof v === "number") return v; if (typeof v === "string" && v.trim() !== "") { const n = Number(v); if (Number.isFinite(n)) return n; } return nul ? null : 0;
        case "boolean": return typeof v === "boolean" ? v : typeof v === "string" ? v === "true" : Boolean(v);
        case "array": return Array.isArray(v) ? (v as FieldInput) : (nul ? null : []);
        case "object": return typeof v === "object" ? (v as FieldInput) : (nul ? null : {});
        default: return v as FieldInput;
    }
}
export function conformFields(raw: Record<string, unknown>, def: SchemaDefinition): Record<string, FieldInput> {
    const out: Record<string, FieldInput> = {};
    for (const [name, fd] of Object.entries(def)) {
        const rt = fd["@type"];
        out[name] = coerce(raw[name], rt.replace("| null", "").trim(), rt.includes("| null"));
    }
    return out;
}

// ── idempotent schema registration (mirrors publish_bundle.ts::ensureResolver) ──
/**
 * Ensure a node schema is registered, returning its id. On-chain schemas are
 * IMMUTABLE by name, so if one is already registered with a DIFFERENT field set
 * we throw an actionable error rather than let every node fail per-field
 * validation deep in the builder.
 */
export async function ensureResolver(
    fangorn: Fangorn,
    name: string,
    definition: SchemaDefinition,
    identity: NodeIdentity | undefined,
    skip: boolean,
    log: (msg: string) => void = () => { /* silent */ },
): Promise<Hex> {
    let id: Hex | null = null;
    try {
        const registry = fangorn.getSchemaRegistry();
        const computedId = await registry.schemaId(name);
        if (await registry.schemaExists(computedId)) id = computedId;
    } catch { /* none */ }

    if (id) {
        log(`schema "${name}" already registered → ${id}`);
        const onchain = await fangorn.schema.get(name).catch((e: unknown) => {
            log(`  ⚠️  could not read on-chain schema "${name}" to verify its shape: ${(e as Error).message}`);
            return undefined;
        });
        if (onchain?.kind === "resolver") {
            const localKeys = new Set(Object.keys(definition));
            const chainKeys = new Set(Object.keys(onchain.definition));
            const onlyChain = [...chainKeys].filter(k => !localKeys.has(k));
            const onlyLocal = [...localKeys].filter(k => !chainKeys.has(k));
            if (onlyChain.length || onlyLocal.length) {
                throw new Error(
                    `schema "${name}" is already registered on-chain with a DIFFERENT shape — ` +
                    `schemas are immutable by name, so this data cannot be published under it.\n` +
                    (onlyChain.length ? `  fields only on-chain : ${onlyChain.sort().join(", ")}\n` : "") +
                    (onlyLocal.length ? `  fields only in local : ${onlyLocal.sort().join(", ")}\n` : "") +
                    `  → Give this dataset its own schema namespace: re-run \`quickbeam data schemagen\` ` +
                    `with a distinct --prefix (or --version), then publish again.`,
                );
            }
        }
        return id;
    }

    if (skip) throw new Error(`--skip-register but "${name}" not registered`);
    const { schemaId } = await fangorn.schema.register({ name, definition, identity });
    log(`registered "${name}" → ${schemaId}${identity ? `  [identity: ${JSON.stringify(identity)}]` : ""}`);
    return schemaId;
}

/** Load `<schemasDir>/fangorn_schemas.json` (schemagen consolidated output). */
export function loadConsolidatedSchemas(schemasDir: string): ConsolidatedSchemas {
    const path = join(schemasDir, "fangorn_schemas.json");
    if (!existsSync(path)) throw new Error(`Not found: ${path} — run \`quickbeam data schemagen\` first.`);
    return JSON.parse(readFileSync(path, "utf8")) as ConsolidatedSchemas;
}

// ── high-level: prepare a bundle source (register schemas + streamers) ─────────
export interface BundleSource {
    bundleName: string;
    bundleId: Hex;
    rootType: string;
    /** Node types present on disk, in bundle.nodes order (for logging). */
    nodeTypes: string[];
    /** Mutated as nodes()/edges() are consumed — read after iteration for a summary. */
    stats: { nodes: number; edges: number };
    nodes(): AsyncIterable<{ id: string; type: string; fields: Record<string, FieldInput> }>;
    edges(): AsyncIterable<{ rel: string; from: string; to: string }>;
}

/**
 * Read a schemagen `stage_volumes` directory, register its node + bundle schemas
 * (idempotent), and return lazy node/edge streamers ready to hand to
 * `publisher.commitBundle`. This is the non-sharded streaming path (the whole
 * graph as ONE commit); huge datasets that need laptop-sized transactions still
 * use `publish_bundle.ts --shard-roots` until that path is ported here too.
 */
export async function prepareBundleSource(
    fangorn: Fangorn,
    opts: {
        inputDir: string;
        schemasDir: string;
        volume: number;
        rootType?: string;
        limit?: number;
        skipRegister?: boolean;
        log?: (msg: string) => void;
    },
): Promise<BundleSource> {
    const log = opts.log ?? (() => { /* silent */ });
    const limit = opts.limit ?? 0;
    const { schemas, bundle } = loadConsolidatedSchemas(opts.schemasDir);
    const defByName = new Map(schemas.map(s => [s.name, s.definition]));
    const identityByName = new Map(schemas.map(s => [s.name, s.identity]));

    const typePath = await makeTypeResolver(opts.inputDir, opts.volume);
    const rootType = opts.rootType ?? Object.keys(bundle.bundle.nodes)[0];

    const typeFiles = Object.keys(bundle.bundle.nodes)
        .map(type => ({ type, schemaName: bundle.bundle.nodes[type], path: typePath(type) }))
        .filter((f): f is { type: string; schemaName: string; path: string } => {
            if (!f.path) { log(`⚠️  no file for node type ${f.type} — skipping`); return false; }
            return true;
        });
    const edgesPaths = edgeFilesFor(opts.inputDir, opts.volume);
    for (const p of edgesPaths) if (!existsSync(p)) throw new Error(`Not found: ${p}`);
    if (edgesPaths.length === 0) throw new Error(`No volume_*_edges.json in ${opts.inputDir}`);

    // register node schemas (idempotent) then the bundle schema
    for (const { schemaName } of typeFiles) {
        const def = defByName.get(schemaName);
        if (!def) throw new Error(`No definition for ${schemaName} in fangorn_schemas.json`);
        await ensureResolver(fangorn, schemaName, def, identityByName.get(schemaName), opts.skipRegister ?? false, log);
    }
    let bundleId: Hex | null = null;
    try {
        const registry = fangorn.getSchemaRegistry();
        const computedId = await registry.schemaId(bundle.name);
        if (await registry.schemaExists(computedId)) bundleId = computedId;
    } catch { /* none */ }
    if (bundleId) {
        log(`bundle "${bundle.name}" already registered → ${bundleId}`);
    } else if (opts.skipRegister) {
        throw new Error(`--skip-register but bundle "${bundle.name}" not registered`);
    } else {
        ({ schemaId: bundleId } = await fangorn.schema.register({ kind: "bundle", name: bundle.name, bundle: bundle.bundle }));
        log(`registered bundle "${bundle.name}" → ${bundleId}`);
    }

    const stats = { nodes: 0, edges: 0 };
    async function* nodes(): AsyncIterable<{ id: string; type: string; fields: Record<string, FieldInput> }> {
        for (const { type, schemaName, path } of typeFiles) {
            const def = defByName.get(schemaName);
            if (!def) continue;
            for await (const node of streamJsonArray<MbNode>(path, limit)) {
                stats.nodes++;
                yield { id: node.name, type, fields: conformFields(node.fields, def) };
            }
        }
    }
    async function* edges(): AsyncIterable<{ rel: string; from: string; to: string }> {
        for (const edgesPath of edgesPaths) {
            for await (const e of streamJsonArray<MbEdge>(edgesPath, limit)) {
                if (!(e.rel && e.from && e.to)) continue;
                stats.edges++;
                yield { rel: e.rel, from: e.from, to: e.to };
            }
        }
    }

    return { bundleName: bundle.name, bundleId, rootType, nodeTypes: typeFiles.map(f => f.type), stats, nodes, edges };
}

// ── high-level: resolve view sources (mirrors publish_view.ts) ─────────────────
const isRid = (s: string): s is Hex => /^0x[0-9a-fA-F]{64}$/.test(s);

export interface ResolvedViewSources {
    sources: Hex[];
    linksets: Hex[];
    sourceSchemas: Hex[];
    trust?: Record<string, unknown>;
}

/**
 * Resolve a view's `--source-bundle`/`--source-resource` (and linkset) specs into
 * resourceIds. A same-owner `name` or `name:dataset` spec is resolved to its
 * datasource resourceId; a raw `0x…` resourceId is a FOREIGN publisher's source.
 */
export async function resolveViewSources(
    fangorn: Fangorn,
    opts: {
        sourceBundle?: string[];
        sourceResource?: string[];
        linksetName?: string[];
        linksetResource?: string[];
        trust?: string;
        log?: (msg: string) => void;
    },
): Promise<ResolvedViewSources> {
    const log = opts.log ?? (() => { /* silent */ });
    const registry = fangorn.getSchemaRegistry();
    const owner = fangorn.getAddress();
    const { DataSourceRegistry } = await import("../registries/datasource-registry/index.js");
    const sourceSchemas = new Set<Hex>();

    const resolveOwnedRid = async (spec: string, kind: string): Promise<Hex> => {
        const colon = spec.indexOf(":");
        const name = colon >= 0 ? spec.slice(0, colon) : spec;
        const datasetLabel = colon >= 0 ? spec.slice(colon + 1) : undefined;
        const schemaId = await registry.schemaId(name);
        if (!(await registry.schemaExists(schemaId))) throw new Error(`${kind} "${name}" is not registered — publish it first.`);
        sourceSchemas.add(schemaId);
        const ds = datasetLabel ?? `${schemaId}:${owner}`;
        const rid = DataSourceRegistry.resourceId(owner, schemaId, ds);
        log(`${kind} "${name}"${datasetLabel ? ` dataset="${datasetLabel}"` : " (default dataset)"} → ${rid}`);
        return rid;
    };

    const sources: Hex[] = [];
    for (const name of opts.sourceBundle ?? []) sources.push(await resolveOwnedRid(name, "source-bundle"));
    for (const r of opts.sourceResource ?? []) {
        if (!isRid(r)) throw new Error(`--source-resource "${r}" is not a 32-byte 0x… resourceId`);
        sources.push(r);
        log(`source-resource (foreign) → ${r}`);
    }
    if (sources.length === 0) throw new Error("a view needs at least one source — pass --source-bundle and/or --source-resource");

    const linksets: Hex[] = [];
    for (const name of opts.linksetName ?? []) linksets.push(await resolveOwnedRid(name, "linkset-name"));
    for (const r of opts.linksetResource ?? []) {
        if (!isRid(r)) throw new Error(`--linkset-resource "${r}" is not a 32-byte 0x… resourceId`);
        linksets.push(r);
    }

    let trust: Record<string, unknown> | undefined;
    if (opts.trust) {
        try { trust = JSON.parse(opts.trust) as Record<string, unknown>; }
        catch { throw new Error(`--trust is not valid JSON: ${opts.trust}`); }
    }

    return { sources, linksets, sourceSchemas: [...sourceSchemas], trust };
}

/**
 * Register a view schema (idempotent by name), returning its id. Registration is
 * idempotent: to CHANGE sources you must bump the view name/version.
 */
export async function ensureView(
    fangorn: Fangorn,
    name: string,
    resolved: ResolvedViewSources,
    skip: boolean,
    log: (msg: string) => void = () => { /* silent */ },
): Promise<Hex> {
    const registry = fangorn.getSchemaRegistry();
    const computedViewId = await registry.schemaId(name);
    if (await registry.schemaExists(computedViewId)) {
        log(`view "${name}" already registered → ${computedViewId} (idempotent by name; bump the version to change sources)`);
        return computedViewId;
    }
    if (skip) throw new Error(`--skip-register but view "${name}" is not registered`);
    const reg = await fangorn.schema.register({
        kind: "view",
        name,
        view: { sources: resolved.sources, linksets: resolved.linksets, trust: resolved.trust, sourceSchemas: resolved.sourceSchemas },
    });
    log(`registered view "${name}" → ${reg.schemaId}`);
    return reg.schemaId;
}
