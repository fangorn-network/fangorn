# Fangorn SDK

commit → push → discover → fetch

Intent-bound data for the agentic web.

Fangorn lets you publish content-addressed graph data, organized into namespaces, so that agents can discover and verify it across any number of publishers. Content is stored in your own storage backend (IPFS via Pinata today); the on-chain **DataRegistry** holds only a single cryptographic pointer per publisher. The protocol coordinates commitment and discovery without ever touching your content directly.

Each publisher owns exactly **one on-chain state root** — the root of a content-addressed Pail tree (`@web3-storage/pail`), wrapped in a commit. Everything you publish lives as key-prefixed **namespaces** inside that one tree. Advancing the root is a compare-and-swap: it *is* a git ref update.

Data is a **metagraph** — **vertices** (a JSON payload tagged by a free-form schema id) and **edges** (a labeled relation between two vertex CIDs) — committed under a namespace.

Datasets are versioned like git: each update is a **commit** that points at its parent, the registry stores only the pointer to the latest commit, and full history lives in IPFS — reconstructible from the on-chain tip alone, no indexer required. `commit` builds locally (permissionless); `push` moves the on-chain pointer (the single permissioned step, fast-forward checked).

> **Note:** access-controlled (encrypted) fields and the purchase → claim → fetch settlement flow are being built on top of this registry and are **not available in the current release**. Registration, namespaces, and the git-native commit / push / log / clone rail are live.

## Supported Networks

- Arbitrum Sepolia

---

## Installation

```sh
npm i @fangorn-network/sdk
```

---

## CLI Quickstart

Install globally and initialize:

```sh
npm i -g @fangorn-network/sdk
fangorn init
```

`fangorn init` prompts for:
- Wallet private key
- Pinata JWT + gateway URL (content + commit-object storage)
- Fangorn access worker URL (reserved for the upcoming access-control flow)

Config is written to `~/.fangorn/config.json`.

You can also configure via environment variables (these take precedence over the config file):

```sh
ETH_PRIVATE_KEY=0x...
PINATA_JWT=...
PINATA_GATEWAY=https://your-gateway.mypinata.cloud
CHAIN_NAME=arbitrumSepolia
WORKER_URL=https://your-worker.workers.dev   # optional (future access control)
```

### Register as a publisher

Register once before committing anything. This records your wallet as a data publisher in the DataRegistry (the registration fee is currently zero).

```sh
fangorn register
```

### Track a namespace (git-native repo)

A **namespace** is a key prefix inside your on-chain tree. `repo init` allocates it and starts tracking it in a local `.fangorn/` pointer file (just a HEAD ref — there is no local object store; commit objects live in IPFS).

```sh
# Allocate a namespace on-chain (no-op if it already exists) and track it here
fangorn repo init rusty-anchor
```

### Commit → push

`commit` snapshots a namespace's vertices/edges into a new commit **locally** (pins the blocks to IPFS, advances your local HEAD) — it does **not** touch the chain. `push` fast-forwards the on-chain state root to your local tip: the single permissioned step.

```sh
# Snapshot graph data into a new local commit — does NOT push
fangorn commit graph.json -m "initial import"

# Settle the local tip on-chain (permission + fast-forward checked here)
fangorn push
fangorn push --force        # push even if it doesn't fast-forward the on-chain tip
```

`graph.json` is a JSON file of vertices and (optionally) the edges between them. Edges reference vertices by their local `id`:

```json
{
  "vertices": [
    { "id": "t1", "tag": "track",  "payload": { "title": "Locura", "artist": "Alice" } },
    { "id": "a1", "tag": "artist", "payload": { "name": "Alice" } }
  ],
  "edges": [
    { "rel": "performed_by", "from": "t1", "to": "a1" }
  ]
}
```

Each commit records its parent, so history is real and walkable. Deleting a vertex is just a later commit that omits it — earlier history is retained. Blocks are content-addressed, so unchanged data is reused byte-for-byte across commits.


### Graph Builders

A graph builders are delegated to the application layer. Developers are responsible for implementing functions that take input and transform it into a set of edges and vertices. See [examples/hackmd](./examples/hackmd/) for an example.

### Inspect

```sh
fangorn status              # local tip vs on-chain tip
fangorn log                 # walk commit history from the tip (newest first)
fangorn log -n 5            # limit
fangorn show                # the tip commit + which keys it changed vs its parent
fangorn show <commitCid>    # a specific commit

# List every vertex and edge committed under a namespace, as JSON
fangorn read                          # defaults to the current repo's namespace + owner
fangorn read rusty-anchor --owner 0x... --pretty
```

### Clone

Reconstruct tracking of a published namespace from its on-chain tip alone. History and contents are then fetched on demand from IPFS.

```sh
fangorn clone <owner> rusty-anchor
fangorn clone <owner> rusty-anchor --dir ./somewhere
```

### Subscribe (light client)

Watch a namespace for on-chain updates and stream the diffs — **no subgraph, no
indexer**. A publisher owns exactly one on-chain root, so this watches that
publisher's `StateCommitted` event (read straight from the RPC node) and, for
each new root, diffs the tree against the previous one restricted to your
namespace's key prefix. Only pushes that actually changed the namespace are
emitted. Diffs are resolved from IPFS on demand.

```sh
# Watch the current repo's namespace; each change is one JSON line on stdout.
fangorn subscribe

# Watch any publisher's namespace explicitly.
fangorn subscribe rusty-anchor --owner 0x...

# Feed an embeddings/index builder directly.
fangorn subscribe rusty-anchor --owner 0x... | my-index-builder
```

Each emitted line is a namespace change:

```jsonc
{
  "namespace": "rusty-anchor",
  "owner": "0x...",
  "commitCid": "bafy...",      // the new on-chain tip
  "blockNumber": "12345678",   // persist this to resume
  "addedVertices": [{ "cid": "bafy...", "schemaId": "track", "payload": { "title": "Locura" } }],
  "addedEdges": [{ "sourceCid": "bafy...", "relation": "by", "targetCid": "bafy..." }],
  "removedVertexCids": ["bafy..."],
  "removedEdges": []
}
```

**Resumability.** The last processed block is saved to
`.fangorn/subscribe-<owner>-<namespace>.json` after each change, so restarting
replays only what you missed (via `eth_getLogs`) before going live. Override or
reset:

```sh
fangorn subscribe --from-block 12000000   # replay from a specific block
fangorn subscribe --from-start            # replay the namespace's full history
```

Without a saved cursor, subscribe starts **live from the current tip** — seed
your initial index from `fangorn read` first, then subscribe for the deltas.

---

## SDK Usage

### Initialization

`Fangorn.create` is synchronous. Pass Pinata storage for any commit/read operation.

```ts
import { Fangorn, FangornConfig } from "@fangorn-network/sdk";

const fangorn = Fangorn.create({
  privateKey: "0x...",
  storage: { pinata: { jwt: process.env.PINATA_JWT!, gateway: process.env.PINATA_GATEWAY! } },
  config: FangornConfig, // defaults to Arbitrum Sepolia
  domain: "localhost",
});

// Register once before committing.
const registry = fangorn.getDataRegistry();
if (!(await registry.isRegistered(fangorn.getAddress()))) {
  await registry.register();
}
```

### Namespaces & the git-native flow

`initRepo` allocates a namespace on-chain (idempotent). Then split building from settling:
`commit` writes a commit object locally (durable in IPFS, HEAD not yet on-chain), and
`push` fast-forwards the on-chain root to it.

```ts
// Allocate the namespace (no-op if it already exists)
await fangorn.initRepo("rusty-anchor");

// First commit — no parent
const c1 = await fangorn.commit({
  namespace: "rusty-anchor",
  message: "initial import",
  vertices: [
    { id: "t1", tag: "track",  payload: { title: "Locura", artist: "Alice" } },
    { id: "a1", tag: "artist", payload: { name: "Alice" } },
  ],
  edges: [{ rel: "performed_by", from: "t1", to: "a1" }],
});

// Settle it on-chain (fast-forward from "no tip yet")
await fangorn.push(c1.commitCid);

// A follow-up commit builds on the previous one
const c2 = await fangorn.commit({
  namespace: "rusty-anchor",
  parent: c1.commitCid,
  message: "add another track",
  vertices: [{ id: "t2", tag: "track", payload: { title: "Otra", artist: "Alice" } }],
});
await fangorn.push(c2.commitCid); // refuses unless it fast-forwards the on-chain tip (pass { force: true } to override)
```

### History, diff & read

Walk history from the on-chain tip (IPFS only, no indexer), and read the current namespace contents:

```ts
const tip = await fangorn.onChainTip(fangorn.getAddress());

// Walk commits, newest first
for await (const c of fangorn.log(tip!)) {
  console.log(c.cid, c.message);
}

// What a commit changed vs. its first parent (namespaced pail keys added/removed)
const diff = await fangorn.show(tip!);

// Every vertex and edge currently committed under a namespace
const contents = await fangorn.inspectNamespace("rusty-anchor");
// contents.vertices: { cid, schemaId, payload }[]   contents.edges: { sourceCid, relation, targetCid }[]
```

> The fast-forward check in `push` is enforced client-side against the on-chain
> head in this release; on-chain write-authorization lands in a later slice.

### Immediate-write helpers

For the common "stage and settle in one shot" case, `upload` (one vertex) and `uploadBatch`
(many vertices + edges) run the whole commit-and-push atomically:

```ts
await fangorn.upload("rusty-anchor", { title: "Locura" }, "track");

await fangorn.uploadBatch(
  "rusty-anchor",
  [{ id: "t1", tag: "track", payload: { title: "Locura" } }],
  [/* edges */],
);
```

### Subscribe (light client)

`subscribe` is an async generator over namespace-scoped changes. It optionally
replays from a block cursor (`fromBlock`) and then watches live until the
`AbortSignal` fires. Each change carries `blockNumber` — persist it to resume.

```ts
const controller = new AbortController();

for await (const change of fangorn.subscribe({
  namespace: "rusty-anchor",
  owner: "0x...",          // defaults to your own address
  fromBlock: savedCursor,  // omit to start live from the current tip
  signal: controller.signal,
})) {
  for (const v of change.addedVertices) index.upsert(v.cid, v.payload);
  for (const cid of change.removedVertexCids) index.remove(cid);
  persistCursor(change.blockNumber);
}
```

The pure diff primitive is also exposed on the engine —
`engine.namespaceDiff(oldRootHex, newRootHex, namespace)` — if you want to diff
two arbitrary roots without watching.

### Storage

Fangorn operates on a 'Bring Your Own Storage' basis. Content-addressed blocks
(vertices, edges, pail shards, commit objects) are pinned to IPFS via Pinata; the chain
holds only the 32-byte commit pointer. Additional backends can be added behind the
`MetadataStorage` interface.

---

## Contracts

### Arbitrum Sepolia

| Contract      | Address                                      |
| ------------- | -------------------------------------------- |
| DataRegistry  | `0x9a3811b365a4aeea1626eaad185b273424ae5e48` |

This is the address in `FangornConfig`; the SDK uses it by default.

---

## Testing

### Unit Tests

```sh
pnpm test
```

### E2E Tests

Runs the storage + on-chain anchor flow against live IPFS + the deployed contract.

```sh
cp env.example .env
pnpm test:e2e
```

Required variables:

| Variable                | Description                               |
| ----------------------- | ----------------------------------------- |
| `ETH_PRIVATE_KEY`       | Publisher private key (needs testnet ETH) |
| `PINATA_JWT`            | Pinata API JWT                            |
| `PINATA_GATEWAY`        | Pinata gateway URL                        |

The publisher must be registered (`fangorn register`, or `registry.register()`) on the target key.

---

## Limitations / Future Work

- Access-controlled (encrypted) fields and the purchase → claim → fetch settlement flow are being built on this registry — not available this release.
- Vertex/edge schema validation is client-side only — no on-chain enforcement.
- Push authorization is client-side in this release; on-chain write policies and non-fast-forward rejection are planned.
- Reads target one publisher's namespace at a time; cross-publisher discovery is a higher layer.

---

## License

MIT
