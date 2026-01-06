# Fangorn

Programmable Privacy

## Usage

### Encryption 

``` js
// initialize a new fangorn client
const fangorn = await Fangorn.init(
  delegatorAccount,
  rpcUrl,
  zkGateAddress as Address,
  jwt,
  gateway,
);

// create a new vault bound to a password
const password = "test";
const vaultId = await fangorn.createVault(password);

// add multiple files
const taxTag = "tax-2025";
const secretTaxData = "Secret Tax Data";
await fangorn.addFile(vaultId, taxTag, secretTaxData, ipfsCid);
await fangorn.addFile(vaultId, "passport", "passport scan", ipfsCid);
await fangorn.addFile(vaultId, "medical", "medical records", ipfsCid);

// commit all at once (one Merkle tree, one manifest, one tx)
await fangorn.commitVault(vaultId);

// Later, add another file (commitVault is called internally)
await fangorn.addFileToExistingVault(
  vaultId,
  "new-doc",
  "new content",
  ipfsCid,
);
```

### Decryption 

``` js
// The tag associated with the data we want to decrypt
const taxTag = "tax-2025";

const fangornDelegatee = await Fangorn.init(
  delegateeAccount,
  rpcUrl,
  zkGateAddress as Address,
  jwt,
  gateway,
);

const plaintext = await fangornDelegatee.decryptFile(
  vaultId,
  taxTag,
  password,
  circuit,
);
console.log("we got the plaintext " + plaintext);
```

## Setup

Testnet tokens (ETH on Base Sepolia) can be obtained from Coinbase's official faucet https://portal.cdp.coinbase.com/

1. `cp .env.example .env`
2. Fill in the ENVs:
   - `DELEGATOR_ETH_PRIVATE_KEY`: The private key of the delegator account
     - Needs to have a balance of test CAMP to send transactions
   - `DELEGATEE_ETH_PRIVATE_KEY`: The private key of the delegatee account
     - Doesn't need to have a balance of test CAMP, used to sign the Lit Auth Sig for the decryption request
   - `CHAIN_RPC_URL`: The RPC URL of the ERC20 chain
     - Expected to be Base sepolia testnet: https://base-sepolia-public.nodies.app
   - `PINATA_JWT`: The JWT for Pinata
     - Can be obtained from: https://app.pinata.cloud/developers/api-keys
     - # Get this from https://app.pinata.cloud/developers/api-keys
  - `PINATA_GATEWAY`: The gateway for Pinata
    -  Can use your own gateway or the default 'https://gateway.pinata.cloud'
  - `LIT_ACTION_CID`: The CID of the lit action for access control checks
    - Can be deployed by the test script, else use "QmcDkeo7YnJbuyYnXfxcnB65UCkjFhLDG5qa3hknMmrDmQ"
  - `VERIFIER_CONTRACT_ADDR`: The Barretenberg verifier contract address 
    - Can be deployed by the test script, else use "0xb88e05a06bb2a2a424c1740515b5a46c0d181639"
  - `ZK_GATE_ADDR`: The ZkGate.sol contract address
    - Can be deployed by the test script, else use "0xec2b41e50ca1b9fc3262b9fd6ad9744c64f135a6"
3. `pnpm i`

## Running the tests

`pnpm test`

The tests will:

1. Build and deploy the solidity verifier to base sepolia (if isDeploy = true in test file)
2. Upload the Lit Action to IPFS (if isDeploy = true in test file)
3. Run the tests:
   - Should fail to decrypt when delegatee provides invalid proof data
   - Should succeed to decrypt when delegatee has a valid proof

## How it works

### Vault Creation

### Encryption and Vault Updates

### Decryption
