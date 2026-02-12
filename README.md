# Fangorn

Intent-Bound Data.

> This is currently a pragmatic initial version of our vision. Expect this repo to undergo radical changes over the coming months.

## Build

To build this project, navigate to the root directory and run `pnpm i`.

### Usage

Fangorn is a zero-knowlege access control framework. It provides tools to register data sources that can be accessed based on owner-defined conditions, like payment.

## Supported Networks

- base sepolia
- arbitrum sepolia

### Encryption

The library is modular and can support various key management systems. We recommend, and use by default, Lit protocol as the main KMS, or in this case, DKMS.

Each datasource points to the content identifier (CID) of a "manifest" stored in IPFS. Each manifest stores a complete record of (encrypted) content, descriptions, and prices inserted by the data owner.

#### Quickstart

Coming soon ;)

```js
# TODO
```

#### Full Guide

```js
// initialize a new fangorn client

const config: AppConfig = {
  litActionCid: litActionCid,
  dataSourceRegistryContractAddress: dataSourceRegistryContractAddress,
  usdcContractAddress,
  chainName: "arbitrum",
  rpcUrl: rpcUrl,
};

// client to interact with LIT proto
const litClient = await createLitClient({
  network: nagaDev,
});

// the domain/webserver where Fangorn is used
const domain = "localhost:3000";

 jwt, gateway
const fangorn = await Fangorn.init(
  delegatorAccount,
  storage,
  client,
  domain,
  config,
);

// create a new named vault
const vaultName = "myvault-001";
const password = "test";
const vaultId = await fangorn.registerDataSource(vaultName);

// upload files to the vault
let filedata = [
	{
		tag: "test0",
		data: "content0",
		extension: ".txt",
		fileType: "text/plain",
		price: "0.0001",
	},
	{
		tag: "test1",
		data: "content1",
		extension: ".png",
		fileType: "image/png",
		price: "0.15",
	},
];
await fangorn.upload(vaultId, filedata);

// easily add more files to the vault
let filedata = [
	{
		tag: "test2",
		data: "content2",
		extension: ".mp4",
		fileType: "video/mp4",
		price: "0.091",
	},
];
await fangorn.upload(vaultId, filedata);

// overwrite a vault
let filedata = [
	{
		tag: "test3",
		data: "content3",
		extension: ".js",
		fileType: "text/javascript",
	},
];
await fangorn.upload(vaultId, filedata, true);
```

### Decryption

Decryption works by providing a vault id, tag, and the valid password to unlock the data. Proof generation is handled by the Fangorn SDK.

```js
// The tag associated with the data we want to decrypt
const taxTag = "tax-2025";
const password = "test";

const domain = "localhost:3000";
const fangorn = await Fangorn.init(delegateeAccount, jwt, gateway, domain);
// try to recover plaintext
const plaintext = await fangorn.decryptFile(vaultId, taxTag, password);

console.log("we got the plaintext " + plaintext);
```

## Testing

### Unit Tests

Run the tests with

```sh
pnpm test
```

### E2E tests

#### Setup

The e2e test suite requires various environment variables that must be manually configured.

Testnet tokens (ETH on Base Sepolia) can be obtained from Coinbase's official faucet https://portal.cdp.coinbase.com/

1. `cp .env.example .env`
2. Fill in the ENVs:
   - `DELEGATOR_ETH_PRIVATE_KEY`: The private key of the delegator account
     - Needs to have a balance of test ETH to send transactions
   - `DELEGATEE_ETH_PRIVATE_KEY`: The private key of the delegatee account
     - Needs to have a balance of test ETH to send transactions
   - `CHAIN_RPC_URL`: The RPC URL of the ERC20 chain
     - Expected to be Base sepolia testnet: https://base-sepolia-public.nodies.app
     - It does not currently support other networks (would require modifying the lit action, which we will do in the future)
   - `PINATA_JWT`: The JWT for Pinata
     - Can be obtained from: https://app.pinata.cloud/developers/api-keys
   - `PINATA_GATEWAY`: The gateway for Pinata
     - Can use your own gateway or the default 'https://gateway.pinata.cloud'
   - `LIT_ACTION_CID`: The CID of the lit action for access control checks
     - Can be deployed by the test script, else use "QmcDkeo7YnJbuyYnXfxcnB65UCkjFhLDG5qa3hknMmrDmQ"
   - `VERIFIER_CONTRACT_ADDR`: The Barretenberg verifier contract address
     - Can be deployed by the test script, else use "0xb88e05a06bb2a2a424c1740515b5a46c0d181639"
   - `ZK_GATE_ADDR`: The ZkGate.sol contract address
     - Can be deployed by the test script, else use "0xec2b41e50ca1b9fc3262b9fd6ad9744c64f135a6"

### Running the tests

`pnpm test:e2e`

The tests will:

1. Build and deploy the solidity verifier to base sepolia (unless it is defined in .env)
2. Upload the Lit Action to IPFS (unless it is defined in .env)

## CLI

To install locally:

```sh
chmod +x update_clci.sh
./update_cli.sh
```

```
fangorn - CLI for Fangorn - token-gated content management

Usage: fangorn [command] [options]

Commands:
  create-vault <name>                    Create a new vault

  upload <vaultId> <files...>            Upload file(s) to a vault
    -p, --price <price>                    Price per file (default: "0")
    --overwrite                            Overwrite existing vault contents

  list <vaultId>                         List contents of a vault

  info <vaultId>                         Get vault info from contract

  decrypt <vaultId> <tag>                Decrypt a file from a vault
    -o, --output <path>                    Output file path (default: stdout)

  entry <vaultId> <tag>                  Get info about a specific vault entry

Options:
  -V, --version                          Output version number
  -h, --help                             Display help

Examples:
  fangorn create-vault "weather-data"
  fangorn upload vault-name ./data.json ./image.png --price 0.001
  fangorn upload vault-name ./new-data.json --overwrite
  fangorn list vault-name
  fangorn info vault-name
  fangorn decrypt 0xabc... data.json -o ./decrypted.json
  fangorn entry 0xabc... data.json

Environment Variables (required):
  CHAIN_RPC_URL          RPC endpoint (e.g. https://sepolia.base.org)
  PINATA_JWT             Pinata API JWT
  PINATA_GATEWAY         Pinata gateway URL
  ETH_PRIVATE_KEY        Wallet private key (0x...)

Environment Variables (optional):
  LIT_ACTION_CID         Override default Lit Action CID
  DS_REGISTRY_ADDR  Override default dataSourceRegistry address
  USDC_CONTRACT_ADDRESS  Override default USDC address
  DOMAIN                 Domain for Lit auth (default: localhost:3000)
```
