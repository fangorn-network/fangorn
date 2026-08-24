#!/usr/bin/env node
/**
 * validate-catalog.mjs — check a catalog manifest against docs/CATALOG.md.
 *
 * Offline checks only: shape, types, and the internal cross-checks that catch a
 * stale or half-finished bake (row counts that disagree, centroids in the wrong
 * space). Chain reads are a client's job, not this script's.
 *
 * With --shards <dir>, also hashes the shard files on disk.
 *
 *   node scripts/validate-catalog.mjs <manifest.json> [--shards <dir>]
 */
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const errs = []
const warns = []
const bad = (c, m) => { if (!c) errs.push(m); return c }
const warn = (c, m) => { if (!c) warns.push(m) }

const HEX = n => v => typeof v === 'string' && new RegExp(`^0x[0-9a-fA-F]{${n}}$`).test(v)
const isBytes32 = HEX(64)
const isAddress = HEX(40)
const isSha256 = v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
const isPosInt = v => Number.isInteger(v) && v > 0
/** Money is a decimal string, never a JS number — 0.1 + 0.2 is not 0.3. */
const isAmount = v => typeof v === 'string' && /^\d+(\.\d+)?$/.test(v)

const ROLES = new Set(['identity', 'title', 'subtitle', 'temporal', 'spatial',
  'media', 'tags', 'measures', 'relations', 'text'])

const [file, ...rest] = process.argv.slice(2)
if (!file) { console.error('usage: validate-catalog.mjs <manifest.json> [--shards <dir>]'); process.exit(2) }
const shardDir = rest[0] === '--shards' ? rest[1] : null

const m = JSON.parse(readFileSync(file, 'utf8'))

// ── shape ───────────────────────────────────────────────────────────────────
bad(m.version === 1, `version must be 1, got ${m.version}`)
bad(typeof m.id === 'string' && /^[a-z0-9][a-z0-9._-]*$/.test(m.id), 'id must be a lowercase handle')
bad(typeof m.title === 'string' && m.title.length > 0, 'title is required')

bad(isBytes32(m.app?.appId), 'app.appId must be bytes32')
bad(isBytes32(m.app?.termsHash), 'app.termsHash must be bytes32')
bad(typeof m.app?.termsUri === 'string', 'app.termsUri is required')
bad(isAddress(m.publisher), 'publisher must be an address')

const src = m.source ?? {}
bad(typeof src.namespace === 'string' && src.namespace.length > 0, 'source.namespace is required')
bad(typeof src.commitCid === 'string' && src.commitCid.length > 0, 'source.commitCid is required')
bad(isBytes32(src.root), 'source.root must be bytes32')
bad(isPosInt(src.blockNumber), 'source.blockNumber must be a positive integer')
bad(isBytes32(src.schemaId), 'source.schemaId must be bytes32')

const emb = m.embedding ?? {}
bad(typeof emb.model === 'string' && emb.model.includes('/'), 'embedding.model must be a qualified id (org/name)')
bad(isPosInt(emb.dim), 'embedding.dim must be a positive integer')
bad(['Cosine', 'Dot', 'Euclid'].includes(emb.distance), 'embedding.distance must be Cosine | Dot | Euclid')
warn(typeof emb.recipe === 'string', 'embedding.recipe absent — the bake is not reproducible')
// Asymmetric models are the norm now; declaring neither prefix is usually a bug.
warn('docPrefix' in emb && 'queryPrefix' in emb,
  'embedding prefixes absent — fine for a symmetric model, silent nonsense for an asymmetric one')

// ── shards ──────────────────────────────────────────────────────────────────
const shards = m.cdn?.shards
bad(typeof m.cdn?.index === 'string', 'cdn.index is required')
if (bad(Array.isArray(shards) && shards.length > 0, 'cdn.shards must be a non-empty array')) {
  shards.forEach((s, i) => {
    bad(typeof s.name === 'string', `cdn.shards[${i}].name is required`)
    bad(isSha256(s.sha256), `cdn.shards[${i}].sha256 must be 64 lowercase hex`)
    bad(isPosInt(s.bytes), `cdn.shards[${i}].bytes must be a positive integer`)
    bad(isPosInt(s.rows), `cdn.shards[${i}].rows must be a positive integer`)
  })
}

// ── roles ───────────────────────────────────────────────────────────────────
const roles = m.roles ?? {}
bad(typeof roles.identity === 'string', 'roles.identity is required — a row needs a stable key')
bad(typeof roles.title === 'string', 'roles.title is required — a row needs something to display')
for (const [k, v] of Object.entries(roles)) {
  bad(ROLES.has(k), `roles.${k} is not a known role`)
  bad(typeof v === 'string' || (Array.isArray(v) && v.every(x => typeof x === 'string')),
    `roles.${k} must be a field name or a list of field names`)
}
warn(typeof roles.media === 'string',
  'roles.media absent — nothing in this catalog can be opened or played')

// ── coverage: the cross-checks that catch a stale bake ──────────────────────
const cov = m.coverage ?? {}
bad(isPosInt(cov.rows), 'coverage.rows must be a positive integer')
if (Array.isArray(shards)) {
  const total = shards.reduce((n, s) => n + (s.rows || 0), 0)
  bad(total === cov.rows, `coverage.rows (${cov.rows}) != sum of shard rows (${total})`)
}
if (bad(Array.isArray(cov.centroids) && cov.centroids.length > 0, 'coverage.centroids must be non-empty')) {
  bad(isPosInt(cov.centroidDim), 'coverage.centroidDim must be a positive integer')
  bad(cov.centroidDim <= emb.dim,
    `coverage.centroidDim (${cov.centroidDim}) exceeds embedding.dim (${emb.dim})`)
  let assigned = 0
  cov.centroids.forEach((c, i) => {
    bad(isPosInt(c.n), `coverage.centroids[${i}].n must be a positive integer`)
    assigned += c.n || 0
    if (bad(Array.isArray(c.v) && c.v.length === cov.centroidDim,
      `coverage.centroids[${i}].v must have ${cov.centroidDim} components`)) {
      const norm = Math.sqrt(c.v.reduce((s, x) => s + x * x, 0))
      bad(Math.abs(norm - 1) < 1e-3,
        `coverage.centroids[${i}] is not unit-norm (|v|=${norm.toFixed(4)}) — cosine routing assumes it is`)
    }
  })
  bad(assigned === cov.rows, `centroid membership (${assigned}) != coverage.rows (${cov.rows})`)
}

// ── pricing ─────────────────────────────────────────────────────────────────
const p = m.pricing ?? {}
bad(isAddress(p.payee), 'pricing.payee must be an address')
for (const k of ['mount', 'perItem']) {
  if (p[k] == null) continue
  bad(isAmount(p[k].amount), `pricing.${k}.amount must be a decimal string, not a number`)
  bad(typeof p[k].asset === 'string', `pricing.${k}.asset is required`)
}
warn(!(p.mount?.amount !== '0' || p.perItem) || typeof p.facilitator === 'string',
  'this catalog charges but names no facilitator')

// ── optional: hash the shards on disk ───────────────────────────────────────
if (shardDir && Array.isArray(shards)) {
  for (const s of shards) {
    const path = join(shardDir, s.name)
    if (!existsSync(path)) { errs.push(`missing shard: ${path}`); continue }
    const buf = readFileSync(path)
    const got = createHash('sha256').update(buf).digest('hex')
    bad(got === s.sha256, `${s.name}: sha256 mismatch\n    manifest ${s.sha256}\n    actual   ${got}`)
    bad(buf.length === s.bytes, `${s.name}: bytes mismatch (manifest ${s.bytes}, actual ${buf.length})`)
  }
}

// ── report ──────────────────────────────────────────────────────────────────
for (const w of warns) console.warn(`warn  ${w}`)
if (errs.length) {
  for (const e of errs) console.error(`fail  ${e}`)
  console.error(`\n${errs.length} error${errs.length > 1 ? 's' : ''} in ${file}`)
  process.exit(1)
}
console.log(`ok    ${m.id} — ${cov.rows} rows, ${shards.length} shard(s), ` +
  `${emb.dim}d ${emb.model}${shardDir ? ', shard hashes verified' : ''}` +
  (warns.length ? `, ${warns.length} warning(s)` : ''))
