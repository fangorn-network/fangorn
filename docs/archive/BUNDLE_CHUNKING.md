# Bundle Chunking Logic

How `BundleBuilder` (`src/roles/publisher/builders/bundle.ts`) turns a bundle of
nodes and edges into a set of merkle leaves under a single root.

## Goal

Take a (potentially huge, e.g. 50M-edge) bundle and split it into many small,
fixed-size leaves that all hang off **one merkle root**. The pipeline is
streaming and, under the right flags, memory-bounded regardless of bundle size.

## Inputs (`BundleUploadInput`)

| Field        | Meaning |
|--------------|---------|
| `bundleName` | Name of the bundle. |
| `nodes`      | Array **or** `AsyncIterable` of `{ id, type, fields }`. |
| `edges`      | Optional array/`AsyncIterable` of `{ rel, from, to }`. |
| `chunkSize`  | Entries per merkle leaf. Default **1000**. Nodes are chunked *per type*; edges chunked *across* all edges. |
| `validate`   | Cross-node graph validation (default **true**). Per-record **schema** validation always runs regardless. |

## The `chunk()` pipeline

`chunk()` is an async generator that yields `ChunkDraft`s. It runs in three
phases.

### 0. Setup
- Default `chunkSize` to 1000 if not a positive number.
- `resolveDefs()` fetches each node type's `SchemaDoc` (fields + types) once up
  front so records can be validated/resolved per type.
- Build `declared` set (`rel:from:to`) of allowed relations and a `constrained`
  list of edge shapes that carry a `min`/`max` cardinality.
- Allocate the only unbounded structures **only when `validate` is true**:
  - `nodeType: Map<id, type>` — used to validate edge endpoints + cardinality.
  - `seenIds: Set<id>` — duplicate-id detection.

  With a streamed input and `validate: false`, neither is allocated, so peak
  memory is ~one chunk.

### 1. Nodes — per-type buffers
- Maintain one buffer per node type (`buffers: Map<type, BundleNode[]>`).
- For each incoming node:
  - Reject undeclared types / missing type definitions.
  - If validating: reject duplicate ids, record `id → type`.
  - Run per-record schema validation (`validateRecord`) and resolve fields
    (`resolveRecord`) — **always**, even when `validate: false`.
  - Push into its type's buffer; when a buffer hits `chunkSize`, yield it as a
    `bundle-node:<type>:<seq>` chunk and reset that buffer.
- After the stream ends, flush remaining non-empty buffers in **sorted type
  order** (determinism).
- Throw `"bundle has no nodes"` if zero node chunks were emitted.

### 2. Edges — single growing buffer
- One shared buffer across all edges.
- For each incoming edge, if validating:
  - Resolve `from`/`to` node types via `nodeType`; error on unknown endpoints.
  - Error on undeclared relations.
  - If there are constrained shapes, increment a per-`(from, rel:from:to)`
    counter (keyed with a `\x00` separator).
- Push edge; flush as `bundle-edges:<seq>` whenever the buffer hits `chunkSize`.
- Flush any remainder.
- **Always emit at least one edge chunk** (an empty one if there were no edges)
  so the manifest always has an edge section.

### 3. Cardinality validation (min/max)
- Only when validating *and* there are constrained shapes.
- O(nodes + edges): for each constrained shape, walk `nodeType`, look up the
  edge count for matching `from` nodes, and collect `min`/`max` violations.
- Throw a combined error listing all violations.

## Ordering & merkle correctness

- Every yielded chunk carries a monotonic `seq` equal to its yield order.
- `compareChunks` orders purely by `seq` — a **strict total order** (no ties),
  so `publish()`'s sort restores yield order deterministically and the tree is
  reproducible.
- `assemble()` maps chunk → leaf by **sorted position**: after the sort,
  `ctx.chunks[i]` aligns with `ctx.leaves[i]` (because `leaves = chunks.map(...)`).
  This is robust to upload-completion ordering and to any creation-index baked
  into leaf hashes.

## `assemble()` → `BundleManifest`

Walks the position-aligned chunks/leaves and splits them by `meta.kind`:
- `edges` → `edgeChunks: { dataCid, leaf }[]`
- otherwise → `nodeChunks: { type, dataCid, leaf }[]`

Throws if no edge chunk is present, then returns
`{ kind, schemaId, root, nodeChunks, edgeChunks, tree }`.

## Memory profile summary

| Mode | Peak memory |
|------|-------------|
| Streamed input, `validate: false` | ~one chunk |
| `validate: true` | ~one chunk **+** `nodeType` map + `seenIds` set (+ edge counters for constrained shapes) — i.e. unbounded in node/edge count |

The validation structures are the only unbounded allocations, which is why
disabling validation is the lever for very large streamed publishes.
