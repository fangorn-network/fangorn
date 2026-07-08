# Fangorn SDK

commit → index → discover → prove → settle → fetch

Intent-bound data for the agentic web.

Fangorn lets you publish data organized by schemas, enabling agent-based discovery across any number of publishers. Content is stored in your own storage backend (Cloudflare R2, IPFS, or any compatible future backend). The Fangorn protocol coordinates discovery and commitment without ever touching your content directly.

Everything routes through a single **Publisher Registry**. You register once (`bucket create`); the registry deploys a per-publisher **bucket** and forwards all your schema and datasource operations to it. Schemas, datasources, and reads are keyed by `(publisher, schema name, dataset name)`.

Datasets are versioned like git repositories: each update is a **commit** that points at its parent, the registry stores only a pointer to the latest commit, and full history lives in IPFS. See [`docs/PROTOCOL.md`](docs/PROTOCOL.md) for the complete data model.

> **Note:** access-controlled (handle) fields and the purchase → claim → fetch settlement flow are being re-integrated on top of the unified registry and are **not available in the current release**. Publishing, schemas, bundles, views, and the git-native commit/push/clone rail are fully live.

## Supported Networks

- Arbitrum Sepolia


| Feature | Agent + SQL | Fangorn Stack |
| --- | --- | --- |
| **Primary Use Case** | Ad-hoc internal data exploration. | Distributed, verifiable knowledge graphs. |
| **Trust Model** | Centralized (Must trust the DB admin & the AI). | Decentralized (Trustless, cryptographically verifiable). |
| **Read Latency** | High (Network hop + SQL execution + LLM loop). | Microseconds (Queried locally via edge snapshots). |
| **Data Integrity** | Enforced by standard DB constraints (if configured). | Strict graph-wide schema, cardinality, & Merkle validation. |
| **Scalability** | Vertical/Horizontal DB scaling required. | Infinite scale via Semantic CDN distribution. |

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
- Default chain
- Pinata JWT + gateway URL (for schema/manifest storage)
- Fangorn access worker URL (for content retrieval)

Config is written to `~/.fangorn/config.json`.

You can also configure via environment variables (these take precedence over the config file):

```sh
DELEGATOR_ETH_PRIVATE_KEY=0x...
PINATA_JWT=...
PINATA_GATEWAY=https://your-gateway.mypinata.cloud
WORKER_URL=https://your-worker.workers.dev
CHAIN_NAME=arbitrumSepolia
```

### Register as a publisher

Register once before publishing anything. This deploys your bucket via the Publisher Registry (the registration fee is currently zero).

```sh
# Register as a publisher and deploy your bucket
fangorn bucket create

# Show a publisher's registration + bucket (defaults to your wallet)
fangorn bucket log
fangorn bucket log --owner <address>
```

### Register a Schema

Schemas live in your bucket. Register a publisher first (`bucket create`).

```sh
# Register a schema on-chain (prompts for the JSON schema file path)
fangorn schema register <name>

# Fetch one of your registered schemas by name
fangorn schema get schema.name.v1
```

### Versioned datasets (repos)

A dataset is a **repository**: a schema-typed history of commits, git-style. `commit` snapshots your data locally (chunks it, pins it to IPFS); `push` moves the dataset's on-chain pointer to the new commit — the single permissioned step. History lives entirely in IPFS and is reconstructible from the on-chain tip alone, no indexer required.

```sh
# Create a local repo (a .fangorn/ dir) typed by a schema
fangorn repo init rusty-anchor -s schema.name.v1

# Snapshot records into a new local commit — does NOT push
fangorn commit records.json -m "initial import"

# Publish the local tip on-chain (permission + fast-forward checked here)
fangorn push

# Inspect
fangorn status              # local tip vs on-chain tip
fangorn log                 # walk commit history from the tip
fangorn show                # the tip commit + what it changed vs its parent

# Reconstruct a published dataset from its on-chain tip + IPFS history
fangorn clone <owner> -s schema.name.v1 -d rusty-anchor
```

Each commit records its parent, so history is real and walkable. Deleting a record is just a later commit that omits it — earlier history is retained. Chunks are content-addressed, so unchanged data is reused byte-for-byte across commits and a `commit` only re-uploads what actually changed (`fangorn commit` reports `N uploaded, M reused`).

`commit` isn't limited to record-sets — the same `commit`/`push` rail versions **bundles** (typed node+edge graphs) and **views** (cross-source fusion), so graphs and views gain the same parented history and structural sharing:

```sh
# Commit a typed graph from a `quickbeam data schemagen` stage dir (nodes + edges as one commit)
fangorn commit --bundle ./stage_volumes --volume 0 -m "places+events v1" \
  --embed-model nomic-ai/nomic-embed-text-v1.5 --embed-dim 768   # optional: the embed contract quickbeam inherits

# Commit a composed view fusing already-published sources
fangorn commit --view my.localview.v1 \
  --source-bundle my.placecore.v1 \
  --source-bundle my.eventcore.v1:tribe -m "local view v1"

fangorn push   # same permissioned pointer-move, whatever tree kind the commit wraps
```

Both modes register any missing schemas (idempotent), then build the tree and wrap it in a commit on your local tip. The optional `--embed-model/--embed-dim/--embed-distance` flags (available in every `commit` mode) stamp an embedding contract onto the commit so downstream indexers inherit how to index it rather than hardcoding it.

### Publish Data

The `publish` path overwrites a dataset's pointer in place (no history). For versioned datasets use `commit`/`push` above.

```sh
# Publish records under a schema into a named dataset
fangorn publish upload records.json -s schema.name.v1 -d my-dataset

# Optional: tune chunking and upload parallelism
fangorn publish upload records.json -s schema.name.v1 -d my-dataset --chunk-size 1000 --concurrency 10

# Inspect a specific entry within a dataset
fangorn publish entry track1 -s schema.name.v1 -d my-dataset
```

Records are JSON files containing `PublishRecord` objects (a single object, or an array which is streamed). Handle fields point to content already uploaded to your storage backend and carry the access worker that gates them:

```json
{
  "name": "track1",
  "fields": {
    "title": "Locura",
    "artist": "Alice",
    "audio": {
      "@type": "handle",
      "uri": "r2://my-dir/locura.mp3",
      "workerUrl": "https://your-worker.workers.dev"
    }
  }
}
```

### Inspect your datasets

```sh
# Local tip vs on-chain tip for the repo in the current dir
fangorn status

# One of your published entries within a dataset
fangorn publish entry track1 -s schema.name.v1 -d my-dataset
```

> Consuming another publisher's access-controlled content (the purchase → claim → fetch flow) is being re-integrated on the unified registry and is not available in this release.

---

## SDK Usage

### Initialization

`Fangorn.create` is synchronous. Pass Pinata storage for any publish/schema
operation; the access worker URL travels on each handle field, not here.

```ts
import { Fangorn, FangornConfig } from "@fangorn-network/sdk";

const fangorn = Fangorn.create({
  privateKey: "0x...",
  storage: { pinata: { jwt: process.env.PINATA_JWT!, gateway: process.env.PINATA_GATEWAY! } },
  config: FangornConfig, // defaults to Arbitrum Sepolia
  domain: "localhost",
});

// Register once before publishing — deploys your bucket via the Publisher Registry.
const registry = fangorn.getPublisherRegistry();
if (!(await registry.isRegistered(fangorn.getAddress()))) {
  await registry.register();
}
```

### Storage

Fangorn operates on a 'Bring Your Own Storage' basis.

- Schema definitions and schema-conformant data sets live in IPFS using Pinata.
- Content that should be guarded via Fangorn can live in any store you like. At present the access worker implementation supports Cloudflare R2.

The SDK only handles schemas and manifests. Guarded content itself lives in your storage backend (R2 etc.) and is never handled by the SDK directly.

### Schemas

A `SchemaDefinition` is a JSON object where each field declares its type. Fields marked `@type: "handle"` point to content in an external storage backend — access is enforced by the Fangorn access worker. All other fields are stored inline in the manifest and are publicly readable.

```ts
const definition: SchemaDefinition = {
  title:  { "@type": "string" },
  artist: { "@type": "string" },
  audio:  { "@type": "handle" },  // content lives in R2, access-controlled by worker
};

// Register the schema on-chain
const { schemaId, schemaCid } = await fangorn.schema.register({
  name: "schema.name.v1",
  definition,
});

// Fetch a schema by name
const schema = await fangorn.schema.get("schema.name.v1");
```

### Publishing

Publishing selects a manifest kind by which builder you pass. The convenience wrappers
(`publishRecords`, `publishBundle`, `publishView`, `publishLinkset`) cover the common
cases; `publish({ builder, ... })` is the general form.

#### Record-set

Upload content to your storage backend out-of-band, then publish a manifest pointing at it. The SDK stores the manifest on IPFS and commits the Merkle root on-chain.

```ts
await fangorn.publisher.publishRecords({
  schemaName: "schema.name.v1",
  datasetName: "my-dataset",
  records: [
    {
      name: "track1",
      fields: {
        title:  "Locura",
        artist: "Alice",
        audio:  { "@type": "handle", uri: "r2://my-dir/locura.mp3", workerUrl: "https://your-worker.workers.dev" },
      },
    },
  ],
});
```

The resulting manifest has `kind: "record-set"`. Plain fields (`title`, `artist`) are publicly readable from the manifest; handle fields require a valid on-chain settlement to retrieve via the access worker.

#### Bundle

A bundle is a small typed subgraph spanning multiple schemas. Define the shape once via a bundle schema, then publish node + edge data against it. This is the right primitive for linked data (e.g. tracks + taxonomy + edges between them).

```ts
// 1. Register node schemas (idempotent)
await fangorn.schema.register({ name: "my.track.v1", definition: trackSchema });
await fangorn.schema.register({ name: "my.taxonomy.v1", definition: taxonomySchema });

// 2. Register the bundle shape (idempotent)
await fangorn.schema.register({
  kind: "bundle",
  name: "my.bundle.v1",
  bundle: {
    nodes: { Track: "my.track.v1", Taxonomy: "my.taxonomy.v1" },
    edges: [{ rel: "hasTaxonomy", from: "Track", to: "Taxonomy", min: 1, max: 1 }],
  },
});

// 3. Publish data
await fangorn.publisher.publishBundle({
  bundleName: "my.bundle.v1",
  nodes: [
    { id: "t1", type: "Track",    fields: { trackId: "t1", title: "Locura" } },
    { id: "x1", type: "Taxonomy", fields: { trackId: "t1", genres: ["electronic"] } },
  ],
  edges: [
    { rel: "hasTaxonomy", from: "t1", to: "x1" },
  ],
  datasetName: "my-dataset-v1",
});
```

The resulting manifest has `kind: "bundle"`. Node chunks and edge chunks are stored separately on IPFS and committed together under a single Merkle root.

#### Commits & history

The publish path above overwrites the dataset's pointer in place. The **commit** path
versions it instead: `commitRecords` builds a commit locally (chunk → pin → wrap with its
parent), and `push` moves the on-chain pointer to it. The split is deliberate — building is
permissionless, and only the pointer move is gated.

```ts
// First commit — no parent
const c1 = await fangorn.publisher.commitRecords({
  schemaName: "schema.name.v1",
  datasetName: "rusty-anchor",
  parents: [],
  message: "initial import",
  records: [ /* PublishRecord[] */ ],
});

await fangorn.publisher.push({
  commitCid: c1.commitCid,
  root: c1.root,
  schemaName: "schema.name.v1",
  datasetName: "rusty-anchor",
  expectedParent: undefined, // fast-forward from "no tip yet"
});

// A follow-up commit builds on the previous one. Unchanged chunks are reused
// byte-for-byte, not re-uploaded — see c2.reusedCount / c2.uploadedCount.
const c2 = await fangorn.publisher.commitRecords({
  schemaName: "schema.name.v1",
  datasetName: "rusty-anchor",
  parents: [c1.commitCid],
  message: "fix hours",
  records: [ /* ... */ ],
});

await fangorn.publisher.push({
  commitCid: c2.commitCid,
  root: c2.root,
  schemaName: "schema.name.v1",
  datasetName: "rusty-anchor",
  expectedParent: c1.commitCid, // refuses to push unless it fast-forwards the tip
});
```

Read the current tip and walk history from IPFS alone (no indexer):

```ts
import { ObjectStore } from "@fangorn-network/sdk";

const tip = await fangorn.publisher.resolveTip(owner, "schema.name.v1", "rusty-anchor");

const objects = new ObjectStore(fangorn.getStorage());
for await (const { cid, commit } of objects.walkParents(tip!)) {
  console.log(cid, commit.message);
}

// Blobs a commit added/removed vs. its parent (drives incremental indexing)
const diff = await objects.diffCommit(tip!);
```

> The fast-forward check in `push` is client-side in this release; on-chain
> compare-and-swap + write authorization land in a later slice.

`commitRecords` has counterparts for the other tree kinds — `commitBundle` and
`commitView` — so bundles and views commit through the exact same rail (each accepts
`parents`/`message` and an optional `embed` contract, and returns the same
`{ commitCid, root, reusedCount, uploadedCount, … }`). The `publishBundle`/`publishView`
convenience wrappers remain as the in-place, no-history path.

```ts
// A typed graph, versioned as a commit (structural sharing across commits, like records)
const cb = await fangorn.publisher.commitBundle({
  bundleName: "my.bundle.v1",
  datasetName: "my-graph",
  parents: [prevTip],           // [] for the first commit
  message: "add taxonomy edges",
  nodes: [ /* { id, type, fields } */ ],
  edges: [ /* { rel, from, to } */ ],
  embed: { model: "nomic-ai/nomic-embed-text-v1.5", dim: 768, distance: "Cosine" },
});
await fangorn.publisher.push({ commitCid: cb.commitCid, root: cb.root, schemaName: "my.bundle.v1", datasetName: "my-graph", expectedParent: prevTip });

// A composed view, versioned as a (merge) commit
const cv = await fangorn.publisher.commitView({
  viewName: "my.localview.v1",
  datasetName: "my-view",
  parents: [],
  message: "fuse places + events",
});
```

#### Custom builders

`RecordSetBuilder` and `BundleBuilder` both implement the `ManifestBuilder` interface. You can implement your own and pass it to `publish()`:

```ts
import {
  ManifestBuilder, BuildContext, ChunkDraft, ChunkRef,
  BaseManifest, ResolvedSchemaShape,
} from "@fangorn-network/sdk";

class MyBuilder implements ManifestBuilder<MyInput, MyManifest> {
  readonly kind = "my-kind";
  validate(schema: ResolvedSchemaShape, input: MyInput) { /* ... */ }
  async *chunk(input: MyInput, schema: ResolvedSchemaShape): AsyncIterable<ChunkDraft> {
    yield { name: "chunk:0", data: [] };
  }
  compareChunks(a: ChunkRef, b: ChunkRef) { return a.cid.localeCompare(b.cid); }
  assemble(ctx: BuildContext, input: MyInput, schema: ResolvedSchemaShape): MyManifest { /* ... */ }
}

await fangorn.publisher.publish({
  schemaName: "my.schema.v1",
  builder: new MyBuilder(),
  input: myInput,
  datasetName: "my-dataset",
});
```

### Consuming

Reading published data (manifests, plain fields, bundle/view trees) is done through the publisher/object APIs shown above — `resolveTip`, `ObjectStore.walkParents`, `getManifest`, `readBundle`.

Access-controlled (handle) fields and the **purchase → claim → fetch** settlement flow (with the access worker that gates R2 content) are being re-integrated on top of the unified Publisher Registry and are **not available in the current release**. The consumer role and settlement contracts from the previous three-registry design have been consolidated out; the docs will return once the flow lands on the new registry.

---

## Contracts

### Arbitrum Sepolia

| Contract           | Address                                      |
| ------------------ | -------------------------------------------- |
| Publisher Registry | `0x207ab1866704b2adc34e8ec1069fb8febafff2fd` |

This is the address in `FangornConfig`; the SDK uses it by default. Per-publisher buckets are deployed by the registry on `bucket create` (`register()`).

---

## Testing

### Unit Tests

```sh
pnpm test
```

### E2E Tests

```sh
cp env.example .env
pnpm test:e2e
```

Required variables:

| Variable                         | Description                               |
| -------------------------------- | ----------------------------------------- |
| `DELEGATOR_ETH_PRIVATE_KEY`      | Publisher private key (needs testnet ETH) |
| `PINATA_JWT`                     | Pinata API JWT                            |
| `PINATA_GATEWAY`                 | Pinata gateway URL                        |
| `CHAIN_NAME`                     | `arbitrumSepolia`                         |
| `RPC_URL`                        | RPC endpoint                              |
| `PUBLISHER_REGISTRY_ADDRESS`     | Publisher Registry address                |

The git-native repo E2E (commit → push → history → diff → clone) runs against live IPFS + the deployed contract. The publisher must already be registered (`bucket create`) on the target key.

---

## Limitations / Future Work

- Access-controlled fields and the purchase → claim → fetch settlement flow (plus the access worker) are being re-integrated on the unified Publisher Registry — not available this release.
- Schema validation is client-side only — no on-chain enforcement.
- Push authorization and compare-and-swap are client-side in this release; on-chain enforcement (write policies, non-fast-forward rejection) is planned.
- Reads (`getSchema`, `resolveTip`, manifest getters) target one publisher's bucket at a time; cross-publisher discovery is via views.

---

## License

MIT
