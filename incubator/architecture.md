# Fangorn — Architecture Map

> Package: `@fangorn-network/sdk` — "A zero-knowledge conditional access control framework."
> One-liner: *commit → index → discover → prove → settle → fetch. Intent-bound data for the agentic web.*

## What the system does

Fangorn lets a publisher put data behind **programmable, on-chain-enforced access conditions** while keeping the content in their *own* storage. A buyer pays, proves payment with zero-knowledge, and retrieves the bytes — with **no on-chain link between buyer, seller, and payment**. The SDK coordinates access; it never touches the content.

## Major subsystems

| Subsystem | Path | Role |
|---|---|---|
| **Core SDK facade** | `src/fangorn.ts`, `src/index.ts` | `Fangorn.create()` → `schema` / `publisher` / `consumer` roles |
| **Schema role** | `src/roles/schema/` | Register typed schemas + bundle (subgraph) shapes on-chain; client-side validation |
| **Publisher role** | `src/roles/publisher/` | Build manifests (record-set / bundle), chunk to IPFS, commit Merkle root on-chain |
| **Consumer role** | `src/roles/consumer/` | 3-phase flow: purchase (pay + join Semaphore group) → claim (Groth16 proof + nullifier) → fetch (signed request to access worker) |
| **Registries (on-chain)** | `src/registries/` | SchemaRegistry, DataSourceRegistry, SettlementRegistry (Arbitrum Sepolia) |
| **Crypto** | `src/crypto/` | X25519 ECDH → HKDF-SHA256 → AES-256-GCM; `seal`/`unseal` bound to `resourceId`; TEE-sealed encryption (planned) |
| **Storage providers** | `src/providers/storage/` | Pinata/IPFS for schemas + manifests; content in BYO backend (R2 today) |
| **Access worker** (separate repo) | `fangorn-network/webworker` | Stateless Cloudflare Worker: verifies `is_settled()` on-chain, proxies R2 bytes, never exposes content URL |
| **Agent layer** | `src/builders/a2aCardBuilder.ts` | A2A AgentCard builder; x402/x402f payment responses for agent-accessible data |
| **CLI** | `src/cli/` | `fangorn init / schema / publish / consume` |

## Trust / data flow

```
Publisher: upload content to own R2/IPFS  →  build manifest (Merkle root)  →  pin to IPFS  →  commit root on-chain
Consumer:  pay USDC + join Semaphore group (commitment)  →  Groth16 membership proof → settle on-chain (nullifier)
Fetch:     sign {nullifier, resourceId, objectKey, ts} with stealth key → access worker recovers addr, checks is_settled() → proxies bytes
```

- **Unlinkability** comes from Semaphore (anonymous group membership) + nullifiers + stealth addresses: the payer and the claimer are not linked on-chain.
- **BYO storage**: SDK only ever handles schemas + manifests. Content bytes stay with the publisher.
- **Settlement is the gate**: a single on-chain `is_settled(stealthAddress, resourceId)` bit authorizes retrieval.

## Maturity notes (from README "Limitations" + sealed-e2e)

- Live on **Arbitrum Sepolia** (testnet); Base Sepolia in progress. Three registry contracts deployed.
- Access worker: production-shaped, stateless, open-source, one worker per R2 bucket.
- Schema validation is **client-side only** (no on-chain enforcement yet).
- TEE-sealed field-level encryption + "gadget" condition registry = **designed, mocked in `examples/sealed-e2e.ts`, not yet deployed**. SettlementRegistry currently not redeployed for that path.
- Purchase ledger in-memory only (persistent IPFS-backed ledger in progress).

## Tech stack

TypeScript/ESM, viem + ethers, Noir/Aztec bb.js (Groth16), Semaphore protocol v4, @noble crypto, IPFS (Pinata/Storacha/ipfs-car), LMDB cache, a2a-js + agent0-sdk, solc/Stylus contracts. Build via tsdown; tests via vitest.
