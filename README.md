# Fangorn

Programmable data.

## Overview

Fangorn is a programmable data framework that lets you **register datasources** and **publish encrypted data** under public conditions, or predicates, such that it can only be decrypted if you meet the condition.

## Supported Networks

Fangorn can be deployed on any EVM chain that has a brige to Lit protocol. Currently, contracts are deployed to both Arbitrum Sepolia and Base Sepolia. See the [contracts](#contracts) section for more info.

## Build

`pnpm i

### Usage

Fangorn is a programmable data framework. It provides tools to register data sources that can be accessed based on owner-defined conditions, like payment.

#### Quickstart

```js
# Coming soon
```

#### Full Guide

#### Setup

```js
// provide the account, rpcurl, and chain externally
// Initalize a wallet client
const walletClient = createWalletClient({
  account,,
  transport: http(rpcUrl),
  chain,
});

// For ArbSep, also supports BaseSepolia (wallet client must match)
const config: AppConfig = FangornConfig.ArbitrumSepolia;

// setup the Lit client (for encryption)
const litClient = await createLitClient({
  network: nagaDev,
});
// and the encryption service
const encryptionService = new LitEncryptionService(delegateeLitClient, {
  chainName: chain,
});

// setup the storage client
const pinata = new PinataSDK({
  pinataJwt: jwt,
  pinataGateway: gateway,
});
// we only support pinata right now, more to come
const storage = new PinataStorage(pinata);

// the domain/webserver where Fangorn is used
const domain = "localhost";

const fangorn = await Fangorn.init(
  walletClient,
  storage,
  encryptionService,
  domain,
  config,
);
```

##### Datasource Registration

Now that you have a Fangorn client, you can create a _datasource_. A datasource is an on-chain asset that stores a commitment to its storage root along with an optional `agentId` field for associating the datasource with an ERC-8004 identity.

```js
const name = "demo";
// id = sha256(name || owner), agentId = ""
const id = await this.delegatorFangorn.registerDataSource(name, "");
```

##### Encryption

Once a datasource exists, the owner can update its storage root to point it to data. Fangorn leverages Lit protocol for encryption and access control.

Encryption works by specifying a [gadget](./src/modules/gadgets/README.md), code that represents a logical statement that you want to encrypt under. The gadgets framework is extensible and customizable, allowing for easy custom implementations. For now, we have three gadgets:

- empty wallet: must have an empty wallet to decrypt
- identity: must have a specific identity to decrypt
- payment: must submit a specific payment to decrypt

```js
// configure data using a json array, note that all data in this array will be encrypted under the same condition
// each entry has as (tag, data, extension, fileTpe)
let filedata = [
	{
		tag: "test0",
		data: "content0",
		extension: ".txt",
		fileType: "text/plain",
	},
	{
		tag: "test1",
		data: "content1",
		extension: ".png",
		fileType: "image/png",
	},
];

// this encrypts the file under a USDC payment condition, useful for x402
await fangorn.upload(datasourceName, filedata, async (file) => {
	const commitment = await computeTagCommitment(
		this.delegatorAddress,
		datasourceName,
		file.tag,
		usdcPrice,
	);
	return new PaymentGadget({
		commitment: fieldToHex(commitment),
		chainName: this.config.chainName,
		settlementTrackerContractAddress,
		usdcPrice,
	});
});
```

### Decryption

Decryption mandates that the caller has met the condition specified by the ciphertext. If unknown, the condition can be decoded by fetching the entry from storage (pinata) in which we store a `gadgetDescriptor`, providing pertinent information about the gadget used to encrypt the plaintext and how to satisfy it.

```js
// the address of the owner of the datasource
const owner = "0xabc123...";
// the name of the datasource
const name = "demo";
// the tag of the data we want to fetch
const tag = "test0";

const plaintext = await fangorn.decryptFile(owner, name, tag);
const outputAsString = new TextDecoder().decode(output);
console.log("we got the plaintext " + outputAsString);
```

## Testing

### Unit Tests

Run the tests with:

```sh
pnpm test
```

### E2E tests

#### Setup

The e2e test suite requires various environment variables that must be manually configured. In addition, it must be executed on an actual testnet in order to establish comms with Lit protocol.

Testnet tokens (ETH on Base Sepolia) can be obtained from Coinbase's official faucet https://portal.cdp.coinbase.com/

1. `cp .env.example .env`
2. Fill in the ENVs:
   - `DELEGATOR_ETH_PRIVATE_KEY`: The private key of the delegator account
     - Needs to have a balance of test ETH to send transactions
   - `DELEGATEE_ETH_PRIVATE_KEY`: The private key of the delegatee account
     - Needs to have a balance of test ETH to send transactions

- `PINATA_JWT`: The JWT for Pinata
  - Can be obtained from: https://app.pinata.cloud/developers/api-keys
- `PINATA_GATEWAY`: The gateway for Pinata
  - Can use your own gateway or the default 'https://gateway.pinata.cloud'
- `CHAIN_NAME`: arbitrumSepolia or baseSepolia
- `CAIP2`: The CAIP-2 identifier for the network.
  - 421614 for Arbitrum Sepolia, 84532 for Base Sepolia
- `CHAIN_RPC_URL`: The RPC URL of the chain
  - Expected to be Base sepolia testnet: https://base-sepolia-public.nodies.app or Arbitrum Sepolia: https://sepolia-rollup.arbitrum.io/rpc
- `USDC_CONTRACT_ADDRESS`: The address of the deployed USDC contract
  - 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d for Arbitrum Sepolia 0x036CbD53842c5426634e7929541eC2318f3dCF7e for Base Sepolia
- `DS_REGISTRY_ADDR`: The address of the deployed data registry contract
  - Can be deployed by the test script, else use 0x5bd547ce3b5964c2fc0325f523679f66de391d6f for Arbitrum Sepolia and 0x6fd0e50073dbd8169bcaf066bb4a4991bfa48eeb on Base Sepolia
- `SETTLEMENT_TRACKER_ADDR`: The address of the deployed settlement tracker contract address. This is only needed if you plan to run tests using the payment gadget.
  - Can be deployed by the test script, else use 0x7c6ae9eb3398234eb69b2f3acfae69065505ff69 for Arbitrum Sepolia

Sample:

For Arbitrum Sepolia

```sh
CHAIN_NAME=arbitrumSepolia
CAIP2=421614
CHAIN_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc
USDC_CONTRACT_ADDRESS=0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d
DS_REGISTRY_ADDR=0x602aedafe1096004d4db591b6537bc39d7ac71a6
SETTLEMENT_TRACKER_ADDR=0x7c6ae9eb3398234eb69b2f3acfae69065505ff69
```

For Base Sepolia

```sh
CHAIN_NAME=baseSepolia
CAIP2=84532
CHAIN_RPC_URL=https://base-sepolia-public.nodies.app
USDC_CONTRACT_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
DS_REGISTRY_ADDR=0x6fd0e50073dbd8169bcaf066bb4a4991bfa48eeb
SETTLEMENT_TRACKER_ADDR=0x708751829f5f5f584da4142b62cd5cc9235c8a18
```

### Running the tests

`pnpm test:e2e`

The tests will:

1. Build and deploy the solidity verifier to base sepolia (unless it is defined in .env)
2. Upload the Lit Action to IPFS (unless it is defined in .env)

## Contracts

|                                        | Arbitrum Sepolia                                             | Base Sepolia                                                   |
| -------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------- |
| Datsource Registry Contract Deployment | 0x602aedafe1096004d4db591b6537bc39d7ac71a6                   | 0x6fd0e50073dbd8169bcaf066bb4a4991bfa48eeb                     |
| Datsource Registry Contract Code       | [lib.rs](./contracts/arbitrum/DatasourceRegistry/src/lib.rs) | [DSRegistry.sol](./contracts/src/DSRegistry.sol)               |
| Settlement Tracker Contract Deployment | 0x7c6ae9eb3398234eb69b2f3acfae69065505ff69                   | 0x708751829f5f5f584da4142b62cd5cc9235c8a18                     |
| Settlement Tracker Contract Code       | [lib.rs](./contracts/arbitrum/SettlementTracker//src/lib.rs) | [SettlementTracker.sol](./contracts/src/SettlementTracker.sol) |

## CLI

To install locally:

```sh
chmod +x update_clci.sh
./update_cli.sh
```

```sh
Usage: Fangorn [options] [command]

CLI for Fangorn

Options:
  -V, --version                           output the version number
  -h, --help                              display help for command

Commands:
  register [options] <name>               Register a new datasource as an agent.
  upload [options] <name> <files...>      Upload file(s) to a data source
  decrypt [options] <owner> <name> <tag>  Decrypt a file from a vault
  help [command]                          display help for command
```

## License

MIT
