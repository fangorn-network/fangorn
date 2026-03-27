# Fangorn SDK

Intent-bound encrypted data for the agentic web.

Fangorn lets you publish data encrypted under programmable access conditions — called **gadgets** — so it can only be decrypted by a party that satisfies them. Data is organized by **schemas**, enabling agent-based discovery across any number of publishers.

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

- `fangorn init` prompts for a wallet private key, Pinata JWT, Pinata gateway URL, and default chain. Config is written to `~/.fangorn/config.json`.
- You can also configure via environment variables instead of `fangorn init`:

```sh
DELEGATOR_ETH_PRIVATE_KEY=0x...
# if you use pinata over storacha
PINATA_JWT=...
PINATA_GATEWAY=https://your-gateway.mypinata.cloud
# else email for storacha
STORACHA_EMAIL=...
CHAIN_NAME=arbitrumSepolia
```

### Register a Schema

```sh
# Registers an ERC-8004 agent identity and a schema
fangorn schema register <name>

# Skip agent registration
fangorn schema register <name> --skip-erc

# Fetch a registered schema by name
fangorn schema get schema.name.v1
```

### Publish Data

```sh
# Encrypt and publish files under a schema, priced at 1 USDC unit
fangorn publish upload file.ext -s schema.name.v1 -p 1

# List your manifest entries for a schema
fangorn publish list -s schema.name.v1

# Inspect a specific entry
fangorn publish entry track1 -s schema.name.v1
```

> A price of `1` equals the smallest USDC unit (0.000001 USDC).

### Consume Data

The consumer flow is three phases: **purchase => claim => decrypt**.

```sh
# Phase 1: pay and join the sempaphore group group
fangorn consume purchase <owner> <tag> \
  -s schema.name.v1 \
  --burner-key 0x... \
  --amount 1 \
  --usdc 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d

# Save the identity string printed by purchase — required for the next steps.

# Phase 2: prove membership and claim access (generates a Groth16 ZK proof)
fangorn consume claim <owner> <tag> \
  -s schema.name.v1 \
  --identity '<identity-string>' \
  --stealth <stealth-address>

# Phase 3: decrypt a specific field
fangorn consume decrypt <owner> <tag> \
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
  storage: { pinata: { jwt: "...", gateway: "https://your-gateway.mypinata.cloud" } },
  encryption: { lit: true },
  config: FangornConfig.ArbitrumSepolia,
  domain: "localhost",
});
```

**Storage options:**

| Config | Mode |
|---|---|
| `{ pinata: { jwt, gateway } }` | Read + write |
| `{ storacha: { email } }` | Read + write |
| `{ storacha: { readOnly: true } }` | Read only |

### Schemas

A `SchemaDefinition` is a JSON object where each field declares its type. Fields marked `@type: "encrypted"` are automatically encrypted by the SDK at publish time. All other fields are stored in plaintext. The `gadget` hint on an encrypted field tells the SDK which access condition to apply.

```ts
// Define a schema
const definition: SchemaDefinition = {
  title:  { "@type": "string" },
  artist: { "@type": "string" },
  audio:  { "@type": "encrypted", gadget: "settled" }, // field-level encryption
  cover:  { "@type": "file" },                          // plaintext
};

// Register an ERC-8004 agent identity
const { agentId } = await fangorn.schema.registerAgent({
  name: "schema.agent.name.v1",
  description: "Music streaming data source agent",
});

// Register the schema on-chain
const { schemaId, schemaCid } = await fangorn.schema.register({
  name: "schema.name.v1",
  definition,
  agentId,
});

// Fetch a schema by name
const schema = await fangorn.schema.get("schema.name.v1");
```

When a record conforming to this schema is published, Fangorn encrypts each `@type: "encrypted"` field and replaces its value with a ciphertext handle and a gadget descriptor:

```json
// Input record
{
  "tag": "track1",
  "fields": {
    "title": "Cassini Division",
    "artist": "Arca",
    "audio": { "data": "<bytes>", "fileType": "audio/mp3" }
  }
}

// Stored manifest entry (audio field encrypted)
{
  "tag": "track1",
  "fields": {
    "title": "Cassini Division",
    "artist": "Arca",
    "audio": {
      "@type": "encrypted",
      "handle": {
        "cid": "bafkrei...",
        "gateway": "your-gateway.mypinata.cloud"
      },
      "gadgetDescriptor": {
        "type": "settled",
        "description": "Settlement-gated: SettlementRegistry.isSettled(resourceId, caller)",
        "params": {
          "resourceId": "0xce16c0...",
          "settlementRegistryAddress": "0x4536881306ee355c2f18ae81658771c4488139a3",
          "chainName": "arbitrumSepolia"
        }
      }
    }
  }
}
```

The `gadgetDescriptor` is human- and agent-readable: it describes exactly what a consumer must do to unlock the field. Plaintext fields (`title`, `artist`) remain directly readable in the manifest without any purchase flow.

### Publishing

Each upload encrypts files via the gadget returned by `gadgetFactory`, pins the manifest to IPFS, and commits the new CID on-chain. Subsequent uploads merge with the existing manifest unless `overwrite` is set.

```ts
import { SettledGadget } from "@fangorn-network/sdk/gadgets";
import { SettlementRegistry } from "@fangorn-network/sdk/registries";

const owner = fangorn.getAddress();

await fangorn.publisher.upload(
  {
    records: [
      { tag: "track1", field: "audio", data: audioBytes, extension: ".mp3", fileType: "audio/mpeg" },
      { tag: "track1", field: "cover", data: imageBytes, extension: ".png", fileType: "image/png" },
    ],
    schema: schemaDefinition,
    schemaId,
    gateway: "https://your-gateway.mypinata.cloud",
    gadgetFactory: (tag) =>
      new SettledGadget({
        resourceId: SettlementRegistry.deriveResourceId(owner, schemaId, tag),
        settlementRegistryAddress: FangornConfig.ArbitrumSepolia.settlementRegistryContractAddress,
        chainName: "arbitrumSepolia",
        pinataJwt: "...",
      }),
  },
  1n, // price in smallest USDC units
);
```

### Consuming

#### Phase 1: Purchase

```ts
import { Identity } from "@semaphore-protocol/identity";

const identity = new Identity();

// Sign ERC-3009 authorization with the burner wallet
const preparedRegister = await fangorn.consumer.prepareRegister({
  burnerPrivateKey: "0x...",
  paymentRecipient: ownerAddress,
  amount: 1n,
  usdcAddress: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
  usdcDomainName: "USD Coin",
  usdcDomainVersion: "2",
});

// Submit payment and join the Semaphore group
const { txHash } = await fangorn.consumer.register({
  owner: ownerAddress,
  schemaId,
  tag: "track1",
  identityCommitment: identity.commitment,
  relayerPrivateKey: "0x...",
  preparedRegister,
});

// Save identity.export(). Required for Phase 2 and 3
```

#### Phase 2: Claim

```ts
// Generate Groth16 ZK proof of group membership
const preparedSettle = await fangorn.consumer.prepareSettle({
  resourceId: SettlementRegistry.deriveResourceId(ownerAddress, schemaId, "track1"),
  identity,
  stealthAddress: "0x...",
});

// Submit the proof and trigger the hook call (if configured)
const { txHash, nullifier } = await fangorn.consumer.claim({
  owner: ownerAddress,
  schemaId,
  tag: "track1",
  relayerPrivateKey: "0x...",
  preparedSettle,
});

// Store nullifier. required for Phase 3.
```

#### Phase 3: Decrypt

```ts
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";

const walletClient = createWalletClient({
  account: privateKeyToAccount(stealthPrivateKey),
  chain: arbitrumSepolia,
  transport: http(rpcUrl),
});

const plaintext = await fangorn.consumer.decrypt({
  owner: ownerAddress,
  walletClient,
  schemaId,
  nullifierHash: nullifier,
  tag: "track1",
  field: "audio",
  identity,
});
```

### Gadgets

Gadgets define the access control condition baked into encryption. Built-in gadgets:

| Gadget | Condition |
|---|---|
| `SettledGadget` | Caller must complete a USDC payment + ZK claim flow |

More coming soon ;)

See the [gadgets](./src/modules/gadgets/README.md) docs for details on implementing your own gadgets.

---

## Contracts

### Arbitrum Sepolia

| Contract | Address |
|---|---|
| DataSource Registry | `0x3941c7d50caa56f7f676554bc4e78d77aaf27ebb` |
| Schema Registry | `0x49ab3d52b997e63ad56c91178df48263fd80b2dc` |
| Settlement Registry | `0x4536881306ee355c2f18ae81658771c4488139a3` |

---

## Testing

### Unit Tests

```sh
pnpm test
```

### E2E Tests

Copy the example env and fill in values:

```sh
cp env.example .env
pnpm test:e2e
```

Required variables:

| Variable | Description |
|---|---|
| `DELEGATOR_ETH_PRIVATE_KEY` | Publisher private key (needs testnet ETH) |
| `DELEGATEE_ETH_PRIVATE_KEY` | Consumer private key |
| `PINATA_JWT` | Pinata API JWT |
| `PINATA_GATEWAY` | Pinata gateway URL |
| `CHAIN_NAME` | `arbitrumSepolia` |
| `CAIP2` | `421614` |
| `CHAIN_RPC_URL` | RPC endpoint |
| `USDC_CONTRACT_ADDRESS` | USDC contract address |
| `DS_REGISTRY_ADDR` | DataSourceRegistry address |
| `SCHEMA_REGISTRY_ADDR` | SchemaRegistry address |
| `SETTLEMENT_TRACKER_ADDR` | SettlementTracker address |

Sample `.env` for Arbitrum Sepolia:

```sh
CHAIN_NAME=arbitrumSepolia
CAIP2=421614
CHAIN_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc
USDC_CONTRACT_ADDRESS=0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d
DS_REGISTRY_ADDR=0x6fb3579bfd504cce85b923db335dfc096d912478
SCHEMA_REGISTRY_ADDR=0x49ab3d52b997e63ad56c91178df48263fd80b2dc
SETTLEMENT_TRACKER_ADDR=0x7c6ae9eb3398234eb69b2f3acfae69065505ff69
```

E2E tests deploy any contracts not defined in `.env`, register a test schema, publish manifests, and verify the full purchase → claim → decrypt cycle end-to-end.

---

## License

MIT