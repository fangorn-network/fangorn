# `sealed-e2e.ts` — sealed-encryption end-to-end

A single imperative script that exercises the planned **TEE-sealed encryption**
flow top-to-bottom. No test framework — read it top to bottom and you understand
the protocol. The script is the spec.

## Run

```bash
pnpm e2e:sealed     # or: npm run e2e:sealed
```

It runs **fully offline**. No private key, no RPC, no Pinata, no gas. On success
it prints `✓ sealed e2e passed`; on any failed assertion it prints the failing
step and exits non-zero.

## What it proves

1. `seal(plaintext, teePubkey, resourceId)` produces a ciphertext that **only**
   the TEE can open, and only when keyed to the correct `resourceId`.
2. The `HandleFieldInput.encryption` metadata (`gadget`, `ciphertextHash`,
   `teePubkey`) round-trips through a manifest and is sufficient to locate,
   integrity-check, and decrypt the blob.
3. The settlement gate is enforced: an **unsettled** resource fails to decrypt.

## Protocol (as implemented in the script)

```
seal (publisher):
  ephSec   = X25519 random
  ephPub   = X25519 pub(ephSec)
  shared   = X25519(ephSec, teePubkey)
  aesKey   = HKDF-SHA256(shared, info = resourceId_bytes || ":sealed", len=32)
  nonce    = random 12 bytes
  aesCt    = AES-256-GCM(aesKey, nonce, plaintext)
  ciphertext = ephPub(32) || nonce(12) || aesCt

decrypt (TEE):
  require isSettled(stealthAddress, resourceId)         # the gate
  ephPub, nonce, aesCt = split(ciphertext, 32, 44)
  shared = X25519(teeSecret, ephPub)
  aesKey = HKDF-SHA256(shared, info = resourceId_bytes || ":sealed", len=32)
  plaintext = AES-256-GCM-decrypt(aesKey, nonce, aesCt)

TEE static key:
  teeSecret = HKDF-SHA256(rootKey, info = "fangorn:tee:x25519:v1", len=32)
  teePubkey = X25519 pub(teeSecret)
```

`resourceId` comes from the real SDK: `DataSourceRegistry.resourceId(owner,
schemaId, name)` — the same 32-byte identifier the SettlementRegistry uses. It is
decoded **to bytes** for the HKDF `info` (decoding mismatches are the #1 silent
failure mode, so the script asserts the byte length is 32).

## What's mocked, and why

| Piece | In this script | Real thing (later) |
|---|---|---|
| TEE | `MockTeeServer` — exact crypto, plain method calls, no HTTP | Rust enclave service over `fetch` |
| Storage | `MockStorage` — content-addressed `Map` | IPFS / R2 / access worker |
| Settlement gate | `LocalSettlementRegistry` — in-memory, mirrors the contract's `is_settled = settlements[keccak(stealth_address ‖ resource_id)]` | On-chain `SettlementRegistry.isSettled()` |
| Manifest publish | `MockManifestStore` — `Map` keyed by `schema/dataset/record` | `fangorn.publisher.publishRecords()` → IPFS + DataSourceRegistry |

> The SettlementRegistry is **not deployed** right now. The shared Stylus
> contract is the behavioural benchmark the mock mirrors. When it is redeployed,
> swap `LocalSettlementRegistry.isSettled` for
> `fangorn.getSettlementRegistry().isSettled(...)` and drive settlement through
> the real `consumer.register` → `consumer.claim` flow.

The TEE does **not** re-verify the Semaphore proof — that already happened
on-chain inside `SettlementRegistry.settle()`. The TEE trusts the contract's
settled bit. That is correct behaviour, not a shortcut.

## Environment

None required — the script is self-contained and deterministic enough to run
anywhere. (When the real on-chain settlement path is wired back in, this section
will grow to need `EVM_PRIVATE_KEY`, `ARBITRUM_RPC_URL`, etc.)

## Not in scope (follow-up PRs)

- Real HTTP TEE server (port `MockTeeServer` to Rust, swap method calls for `fetch`).
- Real storage (swap `MockStorage` for the worker's upload/read endpoints).
- Real on-chain settlement (redeploy SettlementRegistry; use `consumer` flow).
- Gadget registry resolution (today `teePubkey` is inline in the handle).
- Streaming / chunked decryption, performance benchmarks.

## Extraction note

`seal()`, `MockTeeServer`, `MockStorage`, and `LocalSettlementRegistry` all live
in the script **on purpose**. They get extracted once the real TEE and storage
layers exist and the interface is known. Pain points discovered while reading
this script are flagged in-code with `// NOTE:` / `// TODO:`.
