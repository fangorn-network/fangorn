# Cross-Publisher Linking — Implementation Plan

*The concrete, test-driven build plan behind the design in
[CROSS_PUBLISHER_LINKING.md](./CROSS_PUBLISHER_LINKING.md). That doc explains
**why**; this doc tracks **what we build, in what order, and how we know each
step is done.***

Status: **living plan** · Last updated 2026-06-25

---

## 0. How to read this doc

- The design doc is the source of truth for *concepts* (Identity / Linkset /
  View, the two join paths, trust). Do not re-litigate those here.
- This doc is the *execution* layer: ordered slices, each with a **goal**,
  **file seams**, a **test-first checkpoint**, and a **definition of done**.
- Every slice is small enough to land as one PR and is **driven by a failing
  test first** (TDD). No slice is "done" until its checkpoint is green and
  `npx tsc --noEmit` is clean.

### Scope boundary — two repos

Cross-publisher linking spans **two codebases**. Keep them separate in your head:

| Repo | Language | Owns | This plan covers it? |
|---|---|---|---|
| **`fangorn`** (this repo) | TypeScript SDK | identity model, schema/artifact types, publish/commit path | **Yes — fully** |
| **`quickbeam`** | Python | embedding index, `build`/`bake`, graph walk, `quickbeam link` | **Tracked, but lives elsewhere** |

When a slice's work is in quickbeam, this plan marks it **[quickbeam]** and
states the *contract* the SDK must expose — it does not implement it here.

---

## 1. The three concepts (one-line recap)

| # | Concept | Job | Artifact |
|---|---|---|---|
| ① | **Identity** | give every entity a global name | Entity URI + namespaced aliases (on the node) |
| ② | **Linkset** | assert cross-edges (fuzzy joins only) | `kind:"linkset"` datasource |
| ③ | **Composed View** | fuse datasources (+linksets) into one graph | `kind:"view"` datasource |

The **View** imposes the graph. The linkset only *supplies edges* in the fuzzy
case. Shared-id joins need **neither** a linkset nor `quickbeam link`.

---

## 2. Current status snapshot

| Slice | State | Notes |
|---|---|---|
| 0.1 Identity primitives (Entity URI, aliases, reserved keys) | ✅ **done** | `src/roles/schema/identity.ts` + 30 passing tests |
| 0.2 Node identity *declaration* type | ✅ **done** | `NodeIdentity` on `SchemaDoc` in `types.ts` |
| 0.3 Carry identity from schema registration into the published bundle | ✅ **done** | schema round-trip + builder emits `entityUri`/`aliases`; tests below |
| 0.4 [quickbeam] key adjacency on global id + Place-ID backfill | ✅  | out-of-repo; SDK contract now satisfied |
| Phase 1+ | ✅  | see below |

**Slice 0.3 landed** in this repo:
- `entityUri` + `aliases` added to `BundleNode` (`src/roles/publisher/types.ts`).
- `BundleBuilder.chunk` stamps them per node (`builders/bundle.ts`); `resolveDefs`
  now reads each node type's `identity`; `chunk` takes a `CommitInfo`
  (`builders/types.ts`) carrying the datasource `resourceId`.
- `PublisherRole.publish` derives `resourceId` once and threads it in (`index.ts`).
- `identity` round-trips through `SchemaRole.register`/`get` (`schema/index.ts`).
- Tests: `builders/bundle.test.ts` (emission), `schema/index.test.ts`
  (round-trip). Full suite green except a **pre-existing** `backpressure.test.ts`
  failure (fails identically on a clean tree — unrelated to this slice).

Everything below slice 0.4 is **not yet started**.

---

## 2.5 Vocabulary & how publishing works today

Slice 0.3 touches the existing publish path, so first — in plain terms — what
that path is and the words this plan uses for its pieces. All of this is current
code; nothing here is new.

### The two things every schema has
1. **schemaId** — a `bytes32` key on-chain (in `SchemaRegistry`). It is *not*
   the schema's content; it's just an identifier you look the content up by.
2. **schema document** — the actual JSON describing the schema (its fields,
   custom types, owner, name). It is **stored off-chain in IPFS**, and the
   registry only remembers its **CID** (content hash). In the code this JSON
   object is the type `ResolverSchemaBlob` (for a normal schema) or
   `BundleSchemaBlob` (for a bundle). *"Schema blob" = this JSON document.*
   Wherever this plan said "blob," read **"the schema's JSON document in IPFS."**

So registering a schema = write the JSON document to IPFS (get a CID) +
record `name → CID` on-chain (get a schemaId).

### Register → store → read-back (today, in `src/roles/schema/index.ts`)
```
SchemaRole.register(params)
  └─ build the schema document object  (ResolverSchemaBlob | BundleSchemaBlob)
  └─ storage.put(document)             → schemaCid   (IPFS content hash)
  └─ schemaRegistry.registerSchema(name, schemaCid) → schemaId  (on-chain)

SchemaRole.get(nameOrId)
  └─ schemaRegistry.getSchema(...)     → { specCid }  (the stored CID)
  └─ storage.get(specCid)              → the schema document back
```
**`specCid` and `schemaCid` are the same thing** seen from the two directions
(write vs read).

### Publishing a bundle (today, in `src/roles/publisher/`)
A *datasource* (the actual rows/nodes/edges) is published separately from its
schema:
```
PublisherRole.commit({ schemaName, builder: BundleBuilder, input })   (index.ts)
  └─ resolveSchema(schemaName)         → the ResolvedBundle (node type → schemaId)
  └─ builder.chunk(input, schema)      → streams ChunkDraft objects
        • BundleBuilder.resolveDefs() fetches EACH node type's schema document
          (storage.get(specCid)) so it can validate/resolve that node's fields
        • for every node: validateRecord → resolveRecord → push into a chunk
  └─ each chunk → IPFS (CAR-batched) → a Merkle leaf
  └─ all leaves → ONE Merkle root → a BundleManifest written to IPFS
```
The node-type schema documents fetched by `resolveDefs()` are **exactly where a
node's `identity` declaration will live** — which is why slice 0.3 is mostly
"carry one more field along a path that already exists."

---

## 2.6 The quickbeam side (how the *other* repo consumes this)

Verified by reading `~/fangorn/embeddings` (the quickbeam Python repo). This
grounds every `[quickbeam]` reference below so the cross-repo contract is
explicit. **Nothing here changes in this repo** — it's context for what our SDK
output has to feed.

### How quickbeam ingests a datasource today
`embeddings.py:build_bundle_joined_data()` (~lines 1016–1141):
1. Query the subgraph for a schema's `ManifestPublished` events → manifest CIDs.
2. Fetch each `BundleManifest` from IPFS; read `nodeChunks[].dataCid` and
   `edgeChunks[].dataCid`; fetch those chunks.
3. **Index nodes by raw id**: `{ node["id"]: node }` (~lines 1092–1098). It reads
   the node *record* directly — `{ id, type, fields }` — and **never fetches the
   schema document**.
4. Build adjacency from edges (`{ from, to, rel }`), both directions, keyed on
   that same raw `id`.
5. `_walk_graph(root_id, adj, …)` BFS (~lines 941–961) + `_project(...)`
   (~lines 964–1000) flatten a root + its neighbors into one document, which gets
   embedded and written to **Qdrant** with payload `{ id, entityType, owner,
   fields, meta }`.

### What this tells us about the contract
- **Today everything keys on `node["id"]`, which is assumed unique per
  datasource.** That single assumption is what blocks cross-publisher linking:
  two publishers' ids live in separate manifests and never meet.
- Because quickbeam reads node *records* (not schema docs), the SDK must put
  global identity **on the node record itself**. That is exactly what slice 0.3
  emits: `entityUri` + `aliases` on each node. **The entire SDK→quickbeam
  interface for Phase 0 is those two fields.**
- `pipelines/fangorn_schema.py` (auto-generates schema/bundle shape from sample
  data) has **no** notion of identity/namespace/alias today — that's Phase-0
  emit work on the quickbeam side, mirroring our `NodeIdentity`.

### What already exists in quickbeam (don't rebuild)
- Multi-hop graph walk + projection (`_walk_graph`/`_project`) — the graph
  machinery is **already there**; Phase 1 only needs it to key on the global id
  and ingest more than one manifest.
- Per-point `owner` tracking in Qdrant payloads — useful later for trust (Phase 4).
- `cli.py` commands: `build`, `serve`, `watch`, `cdn bake`/`serve`, `pull`.
  There is **no** `link`, `view`, linkset, or union-find anywhere yet.

---

## 3. Phase 0 — Global identity *(foundation; no linking yet)*

**Goal:** every published entity has (a) a derivable Entity URI and (b) any
declared namespaced aliases, so a downstream indexer can key on global identity.
No joining happens yet — this is purely *naming*.

### Slice 0.1 — Identity primitives ✅ DONE
- **Deliverable:** pure functions for Entity URI + alias handling.
- **Files:** `src/roles/schema/identity.ts`, `identity.test.ts`.
- **Shipped:** `toEntityUri` / `parseEntityUri` / `isEntityUri`,
  `parseAlias` / `isAlias`, `extractAliases`, `resolveLocalId`, and the
  `FANGORN_SCHEME` / `RESERVED_ID_KEY` (`@id`) / `RESERVED_SAMEAS_REL`
  (`sameAs`) constants.
- **DoD:** ✅ 30 tests green; resourceId derivation matches
  `DataSourceRegistry.resourceId` (`keccak256(owner ‖ schemaId ‖ keccak256(name))`).

### Slice 0.2 — Node identity declaration type ✅ DONE
- **Deliverable:** a way for a node schema to declare its identity.
- **File:** `src/roles/schema/types.ts`.
- **Shipped:** `NodeIdentity { "@id"?: string; aliases?: Record<namespace, field> }`
  added to `SchemaDoc`. Join contract is the **namespace**, not the field name.
- **DoD:** ✅ typechecks; `extractAliases`/`resolveLocalId` consume it.

### Slice 0.3 — Carry identity from schema registration into the published bundle ✅ 
This is the slice that makes 0.1/0.2 actually *do something* end-to-end.

**Plain-English goal:** when a publisher registers a node schema (say
`business.v1`) they can attach an `identity` declaration to it — "the localId
comes from the `placeId` field, and that value is also a `gplace:` alias." That
declaration must (a) survive being written to and read back from IPFS, and (b)
be applied while publishing a bundle, so each node in the resulting
`BundleManifest` carries its **Entity URI** and its **alias list**. After this
slice, you can publish a datasource and read its global identity straight out of
the manifest — still with zero linking logic.

**Why it's small:** every value already flows along this path (§2.5). We are
adding *one optional field* (`identity`) to the schema document and *two derived
values* (`entityUri`, `aliases`) to each emitted node. No new files except a
couple of test files; no new infra.

**Step 1 — let the schema document hold an `identity` declaration.**
- `src/roles/schema/types.ts`: add `identity?: NodeIdentity` to
  `ResolverSchemaBlob` (the JSON-document type — the same place `definition` and
  `types` already live). `SchemaDoc` already has `identity` from slice 0.2.
- `src/roles/schema/index.ts`: add an optional `identity` to the resolver branch
  of `RegisterSchemaParams`, set it on the document in `register()`, and return
  it from `get()` on the resolver branch.
- **Test (RED first), `src/roles/schema/index.test.ts`** *(new file; mock
  storage + registry the way existing role tests do)*: register a resolver
  schema with `identity: { "@id": "placeId", aliases: { gplace: "placeId" } }`,
  then `get()` it and assert the `identity` comes back byte-identical.

**Step 2 — make the bundle builder fetch each node type's `identity`.**
- `src/roles/publisher/builders/bundle.ts`: `resolveDefs()` already does
  `storage.get(specCid)` for every node type. Extend the object it reads so it
  also pulls `identity`, and carry that into the per-type `SchemaDoc` it builds
  (so `chunk()` has the declaration available alongside `fields`/`types`).

**Step 3 — emit Entity URI + aliases per node at chunk time.**
- `src/roles/publisher/builders/bundle.ts` `chunk()`: right after
  `resolveRecord(...)`, call `resolveLocalId(node.id, resolved.fields, decl)` and
  `extractAliases(resolved.fields, decl)` (both from `identity.ts`, slice 0.1).
  Build the Entity URI with `toEntityUri(resourceId, localId)`.
  - **Where does `resourceId` come from?** It is the *bundle datasource's*
    resourceId (`DataSourceRegistry.resourceId(owner, schemaId, name)` — the
    same derivation already used at commit). Thread the committing owner + name
    into the builder, or compute the URIs in `assemble()` where commit context
    is available — **decide this in the slice** (the test will pin whichever).
- Extend the emitted node shape (`BundleNode` in
  `src/roles/publisher/types.ts`) with `entityUri: string` and
  `aliases: string[]`, and surface them in `BundleManifest.nodeChunks` if the
  manifest, not just the chunk data, should carry them. *(Default: put them on
  the node records inside the chunk; the manifest stays a hash index.)*
- **Test (RED first), extend `src/test/publish_bundle.ts` or a new builder
  unit test**: publish a tiny 2-node bundle where one node type declares
  `identity`; assert the emitted node carries the expected `entityUri`
  (`fangorn:<rid>/<promoted-localId>`) and `aliases` (`["gplace:ChIJ…"]`), and a
  node type with no declaration carries `entityUri` using its raw id and
  `aliases: []`.

**Definition of done:**
- New tests green; existing `publish_bundle` test and `validate.test.ts` still
  pass; `npx tsc --noEmit` clean.
- A published bundle's nodes expose Entity URI + aliases; **no joining, no view,
  no linkset** — naming only.
- Update the §2 status table to ✅.
- **Risk: low** (additive field along an existing path).

> **Decision (confirmed by reading quickbeam, §2.6):** put `entityUri` +
> `aliases` **on each node record** inside the chunk. quickbeam indexes node
> *records* by `node["id"]` and never reads the schema document, so identity has
> to ride on the record. The `BundleManifest` stays a pure Merkle/hash index.
> The per-node duplication is the price of keeping quickbeam's "read the record"
> model intact — accept it.

### Slice 0.4 — [quickbeam] key adjacency on the Entity URI + Place-ID backfill ✅ 
- **Out of this repo** (lives in `~/fangorn/embeddings`). Concrete seams:
  - `embeddings.py:build_bundle_joined_data()` (~1092–1098): index nodes by
    `node["entityUri"]` (falling back to `node["id"]` for pre-0.3 data), and
    build the edge adjacency on that same global key.
  - `_walk_graph` (~941–961) / `_project` (~964–1000): no logic change, they
    just operate on whatever key the adjacency uses — so keying the adjacency on
    the Entity URI is the whole change.
  - `pipelines/fangorn_schema.py` (~100–138): emit the `identity` declaration
    (mirror of our `NodeIdentity`) when auto-generating schemas; backfill
    existing `ChIJ…` business ids as `gplace:` aliases.
- **SDK contract this depends on:** node records from slice 0.3 expose
  `entityUri` + `aliases`. **That is the entire interface** — confirmed against
  quickbeam's ingest path.

**Phase 0 exit criterion:** a published datasource's nodes are globally named
and carry their declared aliases — verifiable from the manifest alone, with no
linking logic anywhere yet.

---

## 4. Phase 1 — Composed View + multi-source bake *(the ★ free-join win)*

**Goal:** fuse two shared-id datasources into one browsable graph, zero ML.

- **SDK deliverables:**
  - New artifact `kind:"view"`: `{ sources: Hex[]; linksets: Hex[]; trust: {} }`
    (`linksets`/`trust` present but unused until Phase 2/4).
  - View registers/publishes via the **existing** schema/registry path — it is
    *just another datasource*. New builder under
    `src/roles/publisher/builders/` mirroring `bundle.ts`.
- **Test-first checkpoint:** a `view` round-trips through register/get; its
  resolved form pins each source `resourceId`.
- **[quickbeam] deliverable + seams:** today `build_bundle_joined_data()` takes a
  **single** `schema_id` and fetches one schema's manifests. Phase 1 generalizes
  it to a *view*: resolve the view → its source `resourceId`s → each source's
  manifests, fetch all node/edge chunks across sources into **one** node index
  and **one** adjacency (both keyed on the Entity URI from §2.6).
  - **Union-find on shared global key**: nodes from different sources sharing an
    `alias` (e.g. same `isrc:`) or the same Entity URI collapse to one cluster
    before the graph walk. This is the new code; the walk/projection
    (`_walk_graph`/`_project`) is unchanged.
  - New CLI `build --view <id>` (`cli.py`) routing to the multi-source path.
- **Deliverable (★ milestone):** music(isrc) + art(isrc) → one graph,
  deterministic, no linkset. **Risk: low–med.**

---

## 5. Phase 2 — Linkset artifact *(asserted cross-edges)*

**Goal:** let anyone publish signed cross-edges for the fuzzy case.

- **SDK deliverables:**
  - New artifact `kind:"linkset"`; records `{ from, rel, to, confidence?, evidence? }`
    where `from`/`to` are **Entity URIs or namespaced ids** (may be foreign).
  - `EdgeShape` / `builders/bundle.ts`: allow an edge endpoint to be a foreign
    URI rather than a local node-type name. **This is the one genuinely new
    model change** (per design §10).
  - Publish linksets via the existing Merkle/registry path (signed).
- **Test-first checkpoint:** a linkset with foreign endpoints validates,
  chunks, and assembles into a manifest; an endpoint that is neither a valid
  Entity URI nor a known alias is rejected.
- **[quickbeam] deliverable + seams:** the multi-source ingest from Phase 1
  additionally pulls each view-declared linkset's records and feeds its
  `sameAs` edges into the **same union-find** (so asserted equivalences merge
  clusters just like shared ids do). Honor `minConfidence`; optionally
  Merkle-verify foreign endpoints against each source's committed root. Note
  today's edge adjacency assumes `from`/`to` exist in the *same* manifest
  (§2.6) — linkset edges are the first ones that legitimately cross that
  boundary, so the adjacency builder must stop assuming co-location. **Risk: med.**

---

## 6. Phases 3–5 (summary — not yet planned in detail)

| Phase | What | Where | Risk |
|---|---|---|---|
| **3** | `quickbeam link` — cross-datasource ANN → draft linkset; curation modes | [quickbeam] | **high** (weakest joint) |
| **4** | Trust & reputation — view `trust:{accept,minConfidence}`, ERC-8004 asserter scoring | SDK + quickbeam | med |
| **5** | *(stretch)* federation + on-chain view-output commitment | both | high; defer |

These will get their own detailed slices once Phase 2 lands. Phase 3 is the
risky part; the mitigation is that Phase 4 trust roots make an un-accepted
linkset unable to poison anyone.

---

## 7. Working agreement (so we don't get lost again)

1. **One slice at a time, test-first.** Red → green → refactor → `tsc` clean.
2. **Update the status table in §2** at the end of each slice — it is the
   single place to see where we are.
3. **SDK vs quickbeam stays explicit.** If a step says [quickbeam], we only
   define the SDK-side *contract* here and stop.
4. **No new infrastructure.** Linksets and views are just datasources; they
   reuse publish/commit/serve. If a slice seems to need new infra, stop and
   re-check the design doc.
