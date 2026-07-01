# Fangorn SDK

commit → index → discover → prove → settle → fetch

Intent-bound data for the agentic web.

Fangorn lets you publish data under programmable access conditions. Access is enforced on-chain through settlement verification, so your content is only retrievable by those who have provably paid for it. Data is organized by schemas, enabling agent-based discovery across any number of publishers.
Content is stored in your own storage backend (Cloudflare R2, IPFS, or any compatible future backend). The Fangorn protocol coordinates access without ever touching your content directly.

Datasets are versioned like git repositories: each update is a **commit** that points at its parent, the on-chain registry stores only a pointer to the latest commit, and full history lives in IPFS. See [`docs/PROTOCOL.md`](docs/PROTOCOL.md) for the complete data model.

## Supported Networks

Arbitrum Sepolia (Base Sepolia in progress).


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

### Register a Schema

```sh
# Register a schema on-chain (prompts for the JSON schema file path)
fangorn schema register <name>

# Fetch a registered schema by name
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

### Consume Data

Two read commands are available directly on the CLI:

```sh
# List a publisher's manifest for a schema
fangorn consume list -s schema.name.v1 --owner <address>

# Inspect a single entry
fangorn consume entry track1 -s schema.name.v1 --owner <address>
```

Plain fields are publicly readable. The full **purchase → claim → fetch** flow for
access-controlled (handle) fields is driven through the SDK — see [Consuming](#consuming).

### Data source info

```sh
# Show the on-chain pointer (tip commit / manifest CID) for an owner + schema
fangorn datasource info -s schema.name.v1 --owner <address>
```

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
  config: FangornConfig.ArbitrumSepolia,
  domain: "localhost",
});
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
  schemaId: c1.schemaId,
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
  schemaId: c2.schemaId,
  datasetName: "rusty-anchor",
  expectedParent: c1.commitCid, // refuses to push unless it fast-forwards the tip
});
```

Read the current tip and walk history from IPFS alone (no indexer):

```ts
import { ObjectStore } from "@fangorn-network/sdk";

const tip = await fangorn.publisher.resolveTip(owner, schemaId, "rusty-anchor");

const objects = new ObjectStore(fangorn.getStorage());
for await (const { cid, commit } of objects.walkParents(tip!)) {
  console.log(cid, commit.message);
}

// Blobs a commit added/removed vs. its parent (drives incremental indexing)
const diff = await objects.diffCommit(tip!);
```

> The fast-forward check in `push` is client-side in this release; on-chain
> compare-and-swap + write authorization land in a later slice.

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

The consumer flow for access-controlled (handle) fields is three phases: **purchase → claim → fetch**. Plain fields can be read directly via `consumer.getEntry()` without any of this.

#### Phase 1: Purchase

```ts
import { Identity } from "@semaphore-protocol/identity";

const identity = new Identity();

const preparedRegister = await fangorn.consumer.prepareRegister({
  walletClient,
  paymentRecipient: ownerAddress,
  amount: 1n,
  usdcAddress: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
  usdcDomainName: "USD Coin",
  usdcDomainVersion: "2",
});

const { txHash } = await fangorn.consumer.register({
  owner: ownerAddress,
  schemaId,
  name: "track1",
  identityCommitment: identity.commitment,
  relayerPrivateKey: "0x...",
  preparedRegister,
});

// Save identity.export() — required for Phase 2
```

#### Phase 2: Claim

```ts
import { DataSourceRegistry } from "@fangorn-network/sdk";

const preparedSettle = await fangorn.consumer.prepareSettle({
  resourceId: DataSourceRegistry.resourceId(ownerAddress, schemaId, "track1"),
  identity,
  stealthAddress: "0x...",
});

const { txHash, nullifier } = await fangorn.consumer.claim({
  owner: ownerAddress,
  schemaId,
  name: "track1",
  relayerPrivateKey: "0x...",
  preparedSettle,
});

// Save nullifier — required for Phase 3
```

#### Phase 3: Fetch

```ts
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";

const stealthWalletClient = createWalletClient({
  account: privateKeyToAccount(stealthPrivateKey),
  chain: arbitrumSepolia,
  transport: http(rpcUrl),
});

const { data, contentType } = await fangorn.consumer.fetchField(
  ownerAddress,
  schemaId,
  "track1",
  "audio",
  nullifier.toString(),
  stealthWalletClient,
);
```

The consumer signs `{ nullifier, resourceId, objectKey, timestamp }` with their stealth key. The access worker verifies the signature, checks settlement on-chain, and proxies the content bytes directly from R2. The content URL is never exposed to the client.

---

## Access Worker

The Fangorn access worker is a Cloudflare Worker that gates R2 content behind on-chain settlement verification. Publishers deploy their own worker, with one worker per R2 bucket.

### How it works

1. Consumer signs `{ nullifier, resourceId, objectKey, timestamp }` with their stealth address private key
2. Worker recovers the stealth address from the signature
3. Worker calls `is_settled(stealthAddress, resourceId)` on the Settlement Registry
4. If settled → bytes proxied directly from R2
5. If not → 401

The worker is stateless, open-source, and has no logging. Its only capability is verifying settlement and proxying bytes. The content URL is never exposed to the consumer.

See the [fangorn-access-worker](https://github.com/fangorn-network/webworker) repo for deployment instructions.

---

## Contracts

### Arbitrum Sepolia

| Contract            | Address                                      |
| ------------------- | -------------------------------------------- |
| DataSource Registry | `0x207ab1866704b2adc34e8ec1069fb8febafff2fd` |
| Schema Registry     | `0xecafc21ca3ec41c020287fb8c2126b1a9af9d220` |
| Settlement Registry | `0x93a5e93e76a3c150d35d4cd40029e4f45f3e650f` |

These are the addresses in `FangornConfig.ArbitrumSepolia`; the SDK uses them by default.

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

| Variable                       | Description                               |
| ------------------------------ | ----------------------------------------- |
| `DELEGATOR_ETH_PRIVATE_KEY`    | Publisher private key (needs testnet ETH) |
| `DELEGATEE_ETH_PRIVATE_KEY`    | Consumer private key                      |
| `PINATA_JWT`                   | Pinata API JWT                            |
| `PINATA_GATEWAY`               | Pinata gateway URL                        |
| `WORKER_URL`                   | Access worker URL (optional for Phase 3)  |
| `CHAIN_NAME`                   | `arbitrumSepolia`                         |
| `RPC_URL`                      | RPC endpoint                              |
| `USDC_ADDRESS`                 | USDC contract address                     |
| `DATA_SOURCE_REGISTRY_ADDRESS` | DataSourceRegistry address                |
| `SCHEMA_REGISTRY_ADDRESS`      | SchemaRegistry address                    |
| `SETTLEMENT_REGISTRY_ADDRESS`  | SettlementRegistry address                |

The git-native repo E2E (commit → push → history → diff → clone) runs against live IPFS + the deployed contract. Phase 3 consumer tests are skipped unless `WORKER_URL` is set — run the access worker locally with `wrangler dev --local` and set `WORKER_URL=http://localhost:8787` to enable them.

---

## Limitations / Future Work

- Schema validation is client-side only — no on-chain enforcement.
- Push authorization and compare-and-swap are client-side in this release; on-chain enforcement (write policies, non-fast-forward rejection) is planned.
- The access worker is a trusted component. Future versions will replace it with a TEE or protocol-native verification layer.
- One worker per R2 bucket. Multi-bucket support is planned.

---

## License

MIT
