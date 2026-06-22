# Fangorn — Capability & Asset Map

## Capabilities (what the SDK can actually do today / soon)

| # | Capability | Status | Uniqueness | Notes |
|---|---|---|---|---|
| C1 | **Unlinkable pay-to-access** — prove you paid for a resource with ZK; no on-chain buyer↔seller↔payment link | Live (testnet) | ★★★★★ | Semaphore membership + Groth16 + nullifier + stealth address. This is the crown jewel. |
| C2 | **Settlement-gated content retrieval over BYO storage** — stateless worker proxies R2/IPFS bytes only after on-chain `is_settled()`; content URL never exposed | Live | ★★★★☆ | Publisher keeps custody of data. Comparable: Lit Protocol access control, but Fangorn ties to *payment settlement* not just token-gating. |
| C3 | **On-chain schema + bundle (subgraph) registry** — typed data, Merkle-committed manifests, agent-discoverable across publishers | Live | ★★★☆☆ | Record-set + bundle (nodes/edges) primitives; pluggable `ManifestBuilder`. |
| C4 | **USDC micropayment settlement** (down to 0.000001 USDC) with relayer + `transferWithAuthorization` | Live | ★★★☆☆ | Gasless-ish via relayer; meta-tx EIP-3009 flow. |
| C5 | **Agent-native monetization (x402 / A2A)** — AgentCard builder, x402f payment responses for agent-accessible data | Partial | ★★★★☆ | On-trend with agentic web; thin today (builder + commented examples). |
| C6 | **TEE-sealed field-level encryption + programmable "gadgets"** — encrypt under conditions (Payment, Time, Ownership, Membership), bound to resourceId | Designed/mocked | ★★★★★ | The big future moat. Not deployed. `seal`/`unseal` crypto exists and is parity-tested. |
| C7 | **Content-addressed manifest integrity** — Merkle roots + SHA-256 ciphertext hashes | Live | ★★★☆☆ | Tamper-evident data publishing. |

## Defensibility summary

The **moat = C1 + C2 + C6**: unlinkable, payment-conditioned access to data the publisher still owns. Token-gating (Lit) and crypto-checkout (various) each exist *separately*; the combination of **ZK-unlinkable settlement + BYO-storage gating + programmable decryption conditions** is hard to replicate and is the SDK's defensible core. The application layer should stay thin and let this primitive do the selling.

## Assets that could become products

| Asset | Maturity | Replacement cost | Customer value |
|---|---|---|---|
| Access worker (settlement-gated byte proxy) | High | High | High — drop-in paywall infra |
| Consumer ZK flow (purchase→claim→fetch) | High | Very High | High — unlinkable buyer experience |
| Schema/bundle registry + discovery | Medium-High | Medium | Medium — data interop layer |
| `seal`/`unseal` + gadget design | Medium (crypto done, infra pending) | High | High — conditional encryption |
| x402/A2A agent layer | Low-Medium | Low | High (timing) — agent commerce rail |
| CLI + SDK ergonomics | High | Medium | Medium — adoption surface |
