# Checkpoint Guide 1 — Publishing across schemas, and joining publishers

*A practical walkthrough of what cross-publisher linking lets you do **today**
(Phases 0–1) and what comes **next** (Phase 2, linksets). Companion to the design
in [`docs/CROSS_PUBLISHER_LINKING.md`](./docs/CROSS_PUBLISHER_LINKING.md) and the
build plan in [`docs/CROSS_PUBLISHER_LINKING_PLAN.md`](./docs/CROSS_PUBLISHER_LINKING_PLAN.md).*

Status at this checkpoint:

| Capability | State |
|---|---|
| Global identity on every node (Entity URI + aliases) | ✅ shipped |
| Publish data against multiple schemas (bundles) | ✅ shipped |
| **Composed View** — fuse datasources on a shared key, zero ML | ✅ shipped |
| **Linkset** — asserted cross-edges for the fuzzy case | ⏳ Phase 2 (next) |

---

## 0. The mental model in four lines

- **Identity** — every entity gets a global name: an *Entity URI*
  (`fangorn:<resourceId>/<localId>`) plus any *namespaced aliases* (`isrc:…`,
  `gplace:…`). This is what makes two publishers' rows referrable to each other.
- **Bundle** — one publisher's typed graph (nodes + edges) published as one
  datasource.
- **View** — a recipe that fuses several datasources into one graph. It *imposes*
  the cross-publisher graph. When publishers share a strong key, this is all you
  need — no ML, deterministic.
- **Linkset** *(Phase 2)* — signed, asserted cross-edges for the **fuzzy** case,
  where there is no shared id to join on.

> The **View** is the graph. A linkset only *supplies edges*, and only when a
> shared id isn't available.

---

## 1. Publish data against multiple schemas

A "schema" here is a node type. A **bundle** is the shape that says how several
node types connect. You register the node schemas, register the bundle that
references them, then publish your rows against the bundle.

### 1a. Register node schemas — with identity

The one thing that makes a node *joinable* later is its `identity` declaration:
which field is the node's own id (`@id`), and which fields expose namespaced
aliases. The **join contract is the namespace** (`isrc`), never the field name —
publisher A can store it in `isrc`, B in `isrcCode`, and they still meet.

```ts
import { Fangorn } from "fangorn";

const fangorn = Fangorn.create({
  privateKey: PRIVATE_KEY,
  storage: { pinata: { jwt: PINATA_JWT, gateway: PINATA_GATEWAY } },
  // …chain config…
});

// A music publisher's "Track" type. Its own id is the ISRC; that same value is
// also exposed under the `isrc:` namespace so anyone can join on it.
await fangorn.schema.register({
  name: "music.track.v1",
  definition: {
    isrc:   { "@type": "string" },
    title:  { "@type": "string" },
    artist: { "@type": "string" },
  },
  identity: { "@id": "isrc", aliases: { isrc: "isrc" } },
});
```

> **Promote `@id` only for a field that *is* the node's own id.** A field that
> merely *points at* another node (a foreign key) belongs in `aliases`, never
> `@id` — otherwise every child collapses onto one parent's Entity URI. (The
> `quickbeam data schemagen` inference enforces exactly this: it promotes
> `placeId` on a Business, but keeps a Review's `businessId` as an alias only.)

### 1b. Register a bundle that references the node schemas

```ts
await fangorn.schema.register({
  kind: "bundle",
  name: "music.catalog.v1",
  bundle: {
    nodes: { Track: "music.track.v1", Artist: "music.artist.v1" },
    edges: [{ rel: "performedBy", from: "Track", to: "Artist" }],
  },
});
```

### 1c. Publish rows against the bundle

```ts
await fangorn.publisher.publishBundle({
  bundleName: "music.catalog.v1",
  nodes: [
    { id: "t1", type: "Track",  fields: { isrc: "USRC17607839", title: "Song", artist: "X" } },
    { id: "a1", type: "Artist", fields: { name: "X" } },
  ],
  edges: [{ rel: "performedBy", from: "t1", to: "a1" }],
});
```

Every emitted node now carries a global `entityUri` and its `aliases`
(`["isrc:USRC17607839"]`). Nothing is joined yet — this is purely naming.

For a large, file-backed dataset (the places/music demos), use the streaming
publisher script:

```bash
pnpm dotenvx run -f .env -- tsx src/test/publish_bundle.ts \
  --input-dir ./stage_volumes --volume 0
```

It reads `schemas/fangorn_schemas.json` (produced by `quickbeam data schemagen`),
**registers each node schema with its `identity`**, registers the bundle, and
streams every node/edge into one commitment.

**A second publisher** does the exact same thing with *their* schema — say an
artwork catalog whose `Artwork` type also exposes an `isrc:` alias (cover art
keyed to a recording). Two independent datasources, two `resourceId`s, no shared
infrastructure. They have not met yet.

---

## 2. Fuse them with a Composed View (the free join)

A view is *just another datasource*. You declare which sources to fuse; the
indexer (quickbeam) fetches them all into one graph and **union-find merges any
nodes that share a global key** — same Entity URI, or the same alias (both
`isrc:USRC17607839`). Deterministic, no linkset, no ML.

```ts
// sources are the datasource resourceIds of the two bundles above.
await fangorn.schema.register({
  kind: "view",
  name: "creative.view.v1",
  view: {
    sources: [musicResourceId, artResourceId],
    // linksets: [],  // ← Phase 2, see below
    // trust:    {},  // ← Phase 4
  },
});

await fangorn.publisher.publishView({ viewName: "creative.view.v1" });
```

Then build the fused index:

```bash
quickbeam build --view creative.view.v1=0x<viewSchemaId> --reset
```

quickbeam resolves the view → its sources → every source's manifests → one fused,
deduped graph. A `Track` and an `Artwork` that share `isrc:USRC17607839` collapse
into one entity carrying both publishers' fields.

**This is the whole win when a shared id exists.** You did not write a linkset and
you did not run any matching — the join fell out of identity.

---

## 3. Linksets — the fuzzy join *(Phase 2, next)*

Shared ids are the easy case. The hard case: two publishers describe the same
real thing with **no common key** — "Marina Bar" (a Place) and "Marina Bar &
Grill" (an event venue) with different ids and slightly different names. There is
nothing to union-find on.

A **linkset** is a published, signed datasource whose records are *asserted
cross-edges*:

```
{ from, rel, to, confidence?, evidence? }
```

where `from`/`to` are **Entity URIs or namespaced ids** — and, crucially, they
may be **foreign** (point at a node in someone else's datasource). A `sameAs`
linkset says "these two entities are the same"; the view feeds those assertions
into the *same* union-find that shared ids already use, so an asserted equivalence
merges clusters exactly like a shared key would.

Planned shape (subject to the Phase-2 build):

```ts
// 1. Register a linkset artifact (publishes via the same Merkle/registry path).
await fangorn.schema.register({ kind: "linkset", name: "venue.links.v1" });

// 2. Publish asserted edges between foreign entities.
await fangorn.publisher.publishLinkset({
  linksetName: "venue.links.v1",
  links: [{
    from: "fangorn:0x<places>/ChIJ…",   // a Place
    rel:  "sameAs",
    to:   "fangorn:0x<events>/evt-77",  // an event venue
    confidence: 0.93,
    evidence: { reason: "name+geo match within 12m" },
  }],
});

// 3. Reference the linkset from a view; the fuse honors it (optionally gated by
//    a minConfidence trust policy — Phase 4).
await fangorn.schema.register({
  kind: "view",
  name: "local.view.v1",
  view: { sources: [placesRid, eventsRid], linksets: [venueLinksRid] },
});
```

What's genuinely new in Phase 2 (and why it's its own phase):

- **Foreign edge endpoints.** Today an edge endpoint is a local node-type name;
  a linkset edge points at an entity in *another* datasource. This is the one new
  model change — `EdgeShape` / the bundle builder must accept a foreign URI.
- **Validation.** An endpoint that is neither a valid Entity URI nor a known
  alias is rejected.
- **Cross-manifest adjacency.** quickbeam's edge adjacency currently assumes
  `from`/`to` live in the same manifest; linkset edges are the first that
  legitimately cross that boundary.

Linksets are how `quickbeam link` (Phase 3) will eventually deliver its output:
an ANN pass proposes candidate `sameAs` edges → a human curates → the accepted
ones become a signed linkset. Trust (Phase 4) then ensures a bad linkset can only
affect a consumer who *accepted* its asserter.

---

## 4. Where we are, and what's next

You can today:

1. Publish typed data against multiple schemas, with global identity on every
   node (`§1`).
2. Have **independent publishers** do the same against their own schemas.
3. Fuse them into one browsable graph with a **Composed View** whenever they
   share a strong key — deterministically, no ML (`§2`).

Next up (**Phase 2**): the **linkset** artifact and foreign edge endpoints, so the
*fuzzy* case — same entity, no shared id — can be joined by asserted, signed
`sameAs` edges that flow into the same view fusion.
