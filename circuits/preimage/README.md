# Password verifier circuit

Prove you know a password.

Each vault state is a Merkle root.
Vault owners can insert CIDs into storage by appending to an MMR.
The vault is password protected.
However, each item in the vault is encrypted under a different key.
Note: in the future, we will use IPNS to point vault's to a static CID.

Anybody who knows the password and knows the index of the leaf in the merkle tree that holds the CID they want to decrypt (i.e. a pointer to the ciphertext in storage), prepares a zero knowledge proof that they:

1. know the password
2. know a valid path to SOME CID in the tree

Privacy Guarantees

| What                          | Visible On-Chain | Hidden                 |
| ----------------------------- | ---------------- | ---------------------- |
| Which vault accessed          | ✅               |                        |
| Who accessed (user address)   | ✅               |                        |
| Password                      |                  | ✅                     |
| Which CID accessed            |                  | ✅                     |
| Merkle path/tree structure    |                  | ✅                     |
| Total number of CIDs in vault |                  | ✅ (only root visible) |

Users must also submit a nullifier to ensure that their proofs can't be replayed.

nullifier = blake3(password || user_address || vault_id || cid)

### Limitations

- user address and vault id accessed are still public
- user must get merkle proof path from _somewhere_, so we might need some offchain communcation or indexer
- max tree depth is fixed, we may need to analyze performance tradeoffs and include multiple circuits
