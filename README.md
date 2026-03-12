# Fangorn

Programmable data.

## Overview

Fangorn is a programmable data framework that lets you **publish encrypted data** under public conditions, or predicates, such that it can only be decrypted if you meet the condition(s). Each owner has a single on-chain manifest pointer — a CID referencing their current data tree — which can be updated as data changes. Data schemas group compatible data sources together, enabling agent-based discovery and interoperability.

## Supported Networks

Fangorn contracts are deployed to Arbitrum Sepolia. See the [contracts](#contracts) section for more info.

## Usage

### CLI/Quickstart

To install the fangorn-sdk from NPM, run:
```shell
npm i -g fangorn-sdk
```

### Publish Data

On upload, data is encrypted under a user-specified **gadget**. For now, the CLI only supports the payment gadget, specified via `-g "Payment(amount)"`. The minimum amount is `0.000001`.
```sh
fangorn upload file-to-upload.ext -c arbitrumSepolia -g "Payment(0.0001)"
```

### Decrypt and Download
```sh
fangorn decrypt [owner] [tag] -c arbitrumSepolia
```

## Full Guide

### Build
```sh
pnpm i
```

### Setup
```js
const walletClient = createWalletClient({
  account,
  transport: http(rpcUrl),
  chain,
});

const config: AppConfig = FangornConfig.ArbitrumSepolia;
const encryptionService = new LitEncryptionService(chain);
const storage = new PinataStorage(jwt, gateway);
const domain = "localhost";

const fangorn = await Fangorn.init(
  walletClient,
  storage,
  encryptionService,
  domain,
  config,
);
```

### Schemas

Schemas define a named, versioned interface that data sources conform to. They enable agent-based discovery — any agent built for a given schema can interact with any data source that declares it.
```js
const { schemaId } = await fangorn.schemaRegistry().registerSchema(
  "fangorn.music.v1",       // namespaced name
  "bafy...spec",            // IPFS CID of the JSON schema document
  "agent-card-id",          // ERC-8004 agent ID
);
```

### Publishing Data

Each owner has a single manifest on-chain. Calling `upload` encrypts your files, pins the manifest to IPFS, and publishes the new CID on-chain. Subsequent uploads merge with the existing manifest unless `overwrite` is set.
```js
const filedata = [
  { tag: "track1", data: "...", extension: ".mp3", fileType: "audio/mpeg" },
  { tag: "cover",  data: "...", extension: ".png", fileType: "image/png"  },
];

await fangorn.upload(
  filedata,
  async (file) => new PaymentGadget({
    commitment: fieldToHex(computeTagCommitment(owner, file.tag, price)),
    chainName: "arbitrumSepolia",
    settlementTrackerContractAddress,
    usdcPrice: price,
  }),
  schemaId,  // optional — links manifest to a schema
);
```

### Decryption
```js
const owner = "0xabc123...";
const tag = "track1";

const plaintext = await fangorn.decryptFile(owner, tag);
const output = new TextDecoder().decode(plaintext);
console.log("plaintext:", output);
```

### Gadgets

Gadgets define the access control condition under which data is encrypted. Available gadgets:

- **Empty wallet** — caller must have zero balance to decrypt
- **Identity** — caller must have a specific identity
- **Payment** — caller must submit a specific USDC payment

## Testing

### Unit Tests
```sh
pnpm test
```

### E2E Tests

#### Setup

1. `cp env.example .env`
2. Fill in the required environment variables:

| Variable | Description |
|---|---|
| `DELEGATOR_ETH_PRIVATE_KEY` | Private key of the delegator (needs testnet ETH) |
| `DELEGATEE_ETH_PRIVATE_KEY` | Private key of the delegatee |
| `PINATA_JWT` | Pinata API JWT — [get one here](https://app.pinata.cloud/developers/api-keys) |
| `PINATA_GATEWAY` | Pinata gateway URL |
| `CHAIN_NAME` | `arbitrumSepolia` |
| `CAIP2` | `421614` for Arbitrum Sepolia |
| `CHAIN_RPC_URL` | RPC endpoint |
| `USDC_CONTRACT_ADDRESS` | USDC contract on the target chain |
| `DS_REGISTRY_ADDR` | DataSourceRegistry contract address |
| `SCHEMA_REGISTRY_ADDR` | SchemaRegistry contract address |
| `SETTLEMENT_TRACKER_ADDR` | SettlementTracker contract address |

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

#### Running
```sh
pnpm test:e2e
```

The tests will deploy any contracts not defined in `.env`, register a test schema, publish manifests, and verify encryption/decryption end-to-end.

## Contracts

|  | Arbitrum Sepolia |
|---|---|
| DataSource Registry | `0x6fb3579bfd504cce85b923db335dfc096d912478` |
| Schema Registry | `0x49ab3d52b997e63ad56c91178df48263fd80b2dc` |
| Settlement Tracker | `0x7c6ae9eb3398234eb69b2f3acfae69065505ff69` |

Contract source: [`contracts/arbitrum/`](./contracts/arbitrum/)

## CLI
```sh
Usage: Fangorn [options] [command]

CLI for Fangorn

Options:
  -V, --version                    output the version number
  -h, --help                       display help for command

Commands:
  init                             Configure your Fangorn credentials
  register [options] <name>        Register a schema and ERC-8004 agent identity.
  upload [options] <files...>      Upload file(s) to your data source
  list [options]                   List contents of your data source manifest
  info [options]                   Get your data source info from the contract
  entry [options] <tag>            Get info about a specific entry by tag
  decrypt [options] <owner> <tag>  Decrypt a file from a data source
  help [command]                   display help for command
```

## License

MIT