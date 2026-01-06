# Privacy-Preserving Lit Action Decryption Example

This example demonstrates how to use the Naga Lit Action to decrypt data where the Access Control Conditions is a Lit Action that checks if the user has a valid zero-knowledge proof (on the Base Sepolia testnet).

## Setup

1. `cp .env.example .env`
2. Fill in the ENVs:
   - `DELEGATOR_ETH_PRIVATE_KEY`: The private key of the delegator account
     - Needs to have a balance of test CAMP to send transactions
   - `DELEGATEE_ETH_PRIVATE_KEY`: The private key of the delegatee account
     - Doesn't need to have a balance of test CAMP, used to sign the Lit Auth Sig for the decryption request
   - `ERC20_CHAIN_RPC_URL`: The RPC URL of the ERC20 chain
     - Expected to be Camp testnet: https://rpc.basecamp.t.raas.gelato.cloud
   - `PINATA_JWT`: The JWT for Pinata
     - Can be obtained from: https://app.pinata.cloud/developers/api-keys
3. `pnpm i`

## Running the tests

`pnpm test`

The tests will:

1. Build and deploy the solidity verifier to base sepolia
2. Upload the Lit Action to IPFS
3. Run the tests:
   - Should fail to decrypt when delegatee provides invalid proof data
   - Should succeed to decrypt when delegatee has a valid proof

### TODOs

- For an initial version, we have one lit action per [zkGateContract, verifierContract] combination. That means we need: one lit action per verifier and one verifier per ciphertext. Verifiers can be reused when verifying the same circuits and zkgate contracts can be reused (that is: we only need one zkgate contract for now).
  - the reasoning is pragmnatic: simply calling decrypt doesn't let us pass jsParams, we need to call executeJs instead. However, when calling executeJs we would then decrypt within the LIT action. But there's the problem: the acc we specified requires jsParams.... So we actually need a new acc.
  - We could probably instead encrypt the message under an ACC that expects some specific sig by a specific PKP. In the first LIT action the sig is produced when proofs are valid, then in the second phase decrypt occurs.

- for the verifier/zkgate contracts, do we want to add nullifiers or anythingn?
  - e.g. we can enforce "no double-spending" for proofs (can't reuse them).
  - This is critical in a real scenario imo.

## How it works

### Vault Creation

### Encryption and Vault Updates

### Decryption
