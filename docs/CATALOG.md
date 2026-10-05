# Catalog manifests

A **catalog** is one mountable thing: a namespace, at one commit, baked into
shards, governed by an app's terms, priced, and placed in a named embedding
space. `c3`, `audius`, `places`, a publisher's own library — same object.

A **catalog manifest** is the file a client reads to mount it. It is not a new
source of truth. Every field is a pointer to something that already exists on
chain, in a commit, or in a file whose hash is stated. §9 of [PROTOCOL.md](./PROTOCOL.md)
already puts the embedding model and build recipe *inside the commit*; the
manifest exists so a client can act on that without walking the graph first.

The rule the format is built around:

> **The manifest asserts nothing. It points, and says how to check.**

A client that trusts a manifest without verifying it gets what it deserves. A
client that verifies it needs no trust in whoever served the file — which is why
a manifest can be served from anywhere: a CDN, IPFS, a gist, a Telegram message.

---

## The object

```jsonc
{
  "version": 1,
  "id": "c3",                               // stable, human-typed handle
  "title": "Chaos Communication Congress",

  // ── governance: who publishes this, under whose rules ──────────────
  "app": {
    "appId":     "0x9f2c…",                 // AppRegistry
    "termsHash": "0x4a01…",                 // what publishers accepted
    "termsUri":  "ipfs://bafy…"
  },
  "publisher": "0x8Ab1…",                   // the wallet that pushed the commit

  // ── provenance: exactly which data this is ────────────────────────
  "source": {
    "namespace":  "c3.talks",
    "commitCid":  "bafybeih…",              // the on-chain tip this was baked from
    "root":       "0x71bd…",                // newRoot at that commit
    "blockNumber": 7734112,
    "schemaId":   "0xc410…"
  },

  // ── the space it lives in ─────────────────────────────────────────
  "embedding": {
    "model":       "nomic-ai/nomic-embed-text-v1.5",
    "dim":         768,
    "distance":    "Cosine",
    "docPrefix":   "search_document: ",     // nomic is asymmetric — see below
    "queryPrefix": "search_query: ",
    "recipe":      "bafybeic…"              // build recipe, from the commit
  },

  // ── how to get it ─────────────────────────────────────────────────
  "cdn": {
    "index":  "https://cdn.example/c3/index.json",
    "shards": [
      { "name": "shard-00000.ndjson.gz", "sha256": "9f86d0…", "bytes": 7340032, "rows": 2000 }
    ]
  },

  // ── how to render it, without per-catalog code ────────────────────
  "roles": {
    "identity": "track_id", "title": "title", "subtitle": "speakers",
    "media": "deepLink", "temporal": "date", "tags": ["conference", "language"],
    "text": "text"
  },
  "view": "player",                          // hint only; roles are authoritative

  // ── what it covers, free, before you pay or fetch ─────────────────
  "coverage": {
    "rows": 8746,
    "centroidDim": 128,                      // Matryoshka truncation of `dim`
    "centroids": [ { "n": 412, "v": [0.031, -0.118, "…"] } ]
  },

  // ── how you get in ────────────────────────────────────────────────
  "pricing": {
    "mount":   { "amount": "0", "asset": "USDC" },
    "perItem": null,
    "payee":   "0x8Ab1…",
    "facilitator": "https://x402f.example"
  }
}
```

## Where each field comes from, and how a client checks it

| Field | Source | Verified by |
|---|---|---|
| `app.*` | `AppRegistry` | `appTerms(appId) == termsHash`; publisher `isRegisteredForApp` |
| `publisher` | `StateCommitted` event | the event's `owner` at `blockNumber` |
| `source.commitCid`, `root` | on-chain registry tip | read the tip for `(publisher, namespace)` |
| `embedding.*`, `recipe` | inside the commit | resolve `commitCid`, compare |
| `cdn.shards[].sha256` | the bake | hash the bytes after download |
| `roles` | inferred at bake | re-derivable from the schema |
| `coverage.centroids` | the bake | recomputable from the shards once held |
| `pricing.*` | publisher's choice | **not verifiable** — see below |

A conforming client MUST verify `sha256` on every shard it downloads, and SHOULD
verify the chain reads before spending anything. A manifest whose `commitCid`
does not match the current tip is not invalid — it is **stale**, and staleness is
a normal state, not an error: it names an older, still-verifiable version.

### What is deliberately not verifiable

`pricing`, `title`, and `view` are the publisher's claims. Nothing checks them.
`coverage.centroids` are checkable only *after* you hold the shards — which is
the point: a publisher who overstates coverage to attract mounts is provably
caught by anyone who mounted, and the proof is a recomputation, not an accusation.

---

## Why the commit is load-bearing

Baking from a commit rather than from "the data" buys three things a plain
embeddings dump cannot have:

**Provenance.** A row's answer carries `{publisher, namespace, commitCid, shard
sha256}`. A citation resolves to an immutable version, not to a URL that changed.

**Incremental mounts.** quickbeam indexes commit-to-commit diffs. So a catalog
update is a *shard* diff: a client holding `commitCid: A` fetches only the shards
that differ at `B`. Version control on the data becomes bandwidth savings on the
client, for free.

**Fusion.** Two publishers who both commit against a shared schema, with a
linkset joining them (§6), bake into one searchable space while staying
sovereign. Neither hands the other their data; neither can be de-listed by the
other.

---

## Asymmetric models

`nomic-embed-text-v1.5` embeds documents and queries differently. The taste
kernel's position is a mean of things the user *played* — documents — so it lives
in document space.

- Everything the kernel touches: `docPrefix`.
- Literal typed search only: `queryPrefix`.

Mixing them puts the profile and the catalog in slightly different places and
degrades every ranking without erroring. Both prefixes are in the manifest so a
client never has to know the model's conventions.

---

## The catalog of catalogs

A directory of catalogs is itself a catalog: one row per catalog, embedded as its
`coverage` centroid, `media` role pointing at the manifest URL. So "which catalog
should I mount next" is the same nearest-neighbour operation as "what should I
play next", one level up — and it is kilobytes, so a client can hold it before it
holds anything else.

---

## Check

```sh
node scripts/validate-catalog.mjs docs/examples/c3.catalog.json
node scripts/validate-catalog.mjs <manifest> --shards ./cdn/c3   # also verifies sha256
```
