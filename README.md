# Fangorn

Intent-Bound Data.

> This is currently a pragmatic initial version of our vision. Expect this repo to undergo radical changes over the coming months.

## Usage

Fangorn allows wallets to create private data "vaults" that are password protected. Data can be accessed by providing a zero-knowledge proof, limiting information published onchain about which data was accessed. While this initial version leaks the user address and the id of the vault, it hides the content identifier of actual data accessed.

## Setup

To build this project, navigate to the root directory and run `pnpm i`.

### Encryption

Fangorn allows encrypted data to be added to a 'vault' protected by a user-defined password. First, a user creates a vault

```js
// initialize a new fangorn client against the default testnet configuration (base sepolia)
// the domain/webserver where Fangorn is used
const domain = "localhost:3000";
const fangorn = await Fangorn.init(delegatorAccount, jwt, gateway, domain);

// create a new vault bound to a password
const vaultName = "myvault-001";
const password = "test";
const vaultId = await fangorn.createVault(vaultName, password);

// upload files to the vault
let filedata = [
	{ tag: "test0", data: "content0", extension: ".txt", fileType: "text/plain" },
	{ tag: "test1", data: "content1", extension: ".png", fileType: "image/png" },
];
await fangorn.upload(vaultId, filedata);

// easily add more files to the vault
let filedata = [
	{ tag: "test2", data: "content2", extension: ".mp4", fileType: "video/mp4" },
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
