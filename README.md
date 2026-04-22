# Fangorn SDK

Programmable access control for the agentic web.

Fangorn lets you publish data under programmable access conditions. Access is enforced on-chain through settlement verification, so your content is only retrievable by those who have provably paid for it. Data is organized by schemas, enabling agent-based discovery across any number of publishers.
Content is stored in your own storage backend (Cloudflare R2, IPFS, or any compatible future backend). The Fangorn protocol coordinates access without ever touching your content directly.

## Supported Networks

Arbitrum Sepolia (Base Sepolia in progress).

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
- Pinata JWT + gateway URL (for schema/manifest storage)
- Fangorn access worker URL (for content retrieval)
- Default chain

Config is written to `~/.fangorn/config.json`.

You can also configure via environment variables:

```sh
DELEGATOR_ETH_PRIVATE_KEY=0x...
PINATA_JWT=...
PINATA_GATEWAY=https://your-gateway.mypinata.cloud
WORKER_URL=https://your-worker.workers.dev
CHAIN_NAME=arbitrumSepolia
```

### Register a Schema

```sh
# Register a schema on-chain
fangorn schema register <name>

# Fetch a registered schema by name
fangorn schema get schema.name.v1
```

### Publish Data

```sh
# Publish records under a schema, priced at 1 USDC unit
fangorn publish upload records.json -s schema.name.v1 -p 1

# Inspect a specific entry
fangorn publish entry track1 -s schema.name.v1
```

Records are JSON files containing `PublishRecord` objects. Handle fields point to content already uploaded to your storage backend:

```json
{
  "name": "track1",
  "fields": {
    "title": "Locura",
    "artist": "Alice",
    "audio": { "@type": "handle", "uri": "r2://my-dir/locura.mp3" }
  }
}
```

> A price of `1` equals the smallest USDC unit (0.000001 USDC).

### Consume Data

The consumer flow is three phases: **purchase → claim → fetch**.

```sh
# Phase 1: pay and join the Semaphore group
fangorn consume purchase <owner> <name> \
  -s schema.name.v1 \
  --burner-key 0x... \
  --amount 1 \
  --usdc 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d

# Save the identity string printed by purchase — required for claim.

# Phase 2: prove membership and claim access (generates a Groth16 ZK proof)
fangorn consume claim <owner> <name> \
  -s schema.name.v1 \
  --identity '<identity-string>' \
  --stealth <stealth-address>

# Phase 3: fetch content via the access worker
fangorn consume fetch <owner> <name> \
  -s schema.name.v1 \
  -f audio \
  --nullifier <nullifier> \
  --stealth-key 0x... \
  -o output.mp3

# List a publisher's manifest
fangorn consume list -s schema.name.v1 --owner <address>

# Inspect a publisher's entry
fangorn consume entry track1 -s schema.name.v1 --owner <address>
```

---

## SDK Usage

### Initialization

```ts
import { Fangorn, FangornConfig } from "@fangorn-network/sdk";

const fangorn = await Fangorn.create({
  privateKey: "0x...",
  workerUrl: "https://your-worker.workers.dev",
  config: FangornConfig.ArbitrumSepolia,
  domain: "localhost",
});
```

### Storage

Fangorn operates on a 'Bring Your Own Storage' basis.

- Schema definitions and schema-conformant data sets live in IPFS using Pinata.
- Storage of data that should be guarded via Fangorn can live in any database desired, be it S3 or within IPFS. At present, the implementation only supports Cloudflare R2. 

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
  agentId: "",
});

// Fetch a schema by name
const schema = await fangorn.schema.get("schema.name.v1");
```

### Publishing

Upload content to your R2 bucket out-of-band (via Cloudflare dashboard, wrangler CLI, or your own tooling), then publish a manifest pointing at it. The SDK stores the manifest on IPFS and commits the CID on-chain.

```ts
await fangorn.publisher.upload(
  {
    records: [
      {
        name: "track1",
        fields: {
          title:  "Locura",
          artist: "Alice",
          audio:  { "@type": "handle", uri: "r2://my-dir/locura.mp3" },
        },
      },
    ],
    schemaName: "schema.name.v1",
  },
  1n, // price in smallest USDC units
);
```

The manifest stored on-chain looks like:

```json
{
  "version": 2,
  "schemaId": "0x...",
  "entries": [
    {
      "name": "track1",
      "fields": {
        "title": "Locura",
        "artist": "Alice",
        "audio": {
          "@type": "handle",
          "uri": "r2://my-dir/locura.mp3"
        }
      }
    }
  ]
}
```

Plain fields (`title`, `artist`) are readable by anyone directly from the manifest. Handle fields require a valid on-chain settlement to retrieve via the access worker.

### Consuming

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
const preparedSettle = await fangorn.consumer.prepareSettle({
  resourceId: DataSourceRegistry.resourceIdLocal(ownerAddress, schemaId, "track1"),
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

The consumer signs `{ nullifier, resourceId, objectKey, timestamp }` with their stealth key. The access worker verifies the signature, checks `is_settled()` on-chain, and proxies the content bytes directly from R2. The content URL is never exposed to the client.

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
| DataSource Registry | `0x0e61ca2dbba225580aeab641ab43d623bf5c7e5f` |
| Schema Registry     | `0x4615b03ccaf5e834490a94211e129e6ee8ec6604` |
| Settlement Registry | `0x0309df3ccb232023934b68c9ed068dec74be42cc` |

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
| `CAIP2`                        | `421614`                                  |
| `RPC_URL`                      | RPC endpoint                              |
| `USDC_ADDRESS`                 | USDC contract address                     |
| `DATA_SOURCE_REGISTRY_ADDRESS` | DataSourceRegistry address                |
| `SCHEMA_REGISTRY_ADDRESS`      | SchemaRegistry address                    |
| `SETTLEMENT_REGISTRY_ADDRESS`  | SettlementRegistry address                |

Phase 3 tests are skipped unless `WORKER_URL` is set. Run the access worker locally with `wrangler dev --local` and set `WORKER_URL=http://localhost:8787` to enable them.

---

## Limitations / Future Work

- Schema validation is client-side only — no on-chain enforcement.
- The access worker is a trusted component. Future versions will replace it with a TEE or protocol-native verification layer.
- One worker per R2 bucket. Multi-bucket support is planned.
- Purchase ledger is in-memory only. Persistent ledger backed by IPFS is in progress.

---

## License

MITSonnet 4.6Claude is AI and can make mistakes. Please double-check responses.