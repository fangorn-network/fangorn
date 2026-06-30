# Spec — x402 Paid Data ("Stripe for agent-accessible datasets")

> **Thesis:** any data publisher can expose a dataset as an x402-priced HTTP endpoint that an AI agent pays per-access, with settlement + unlinkable retrieval handled by the Fangorn SDK. The app layer is a thin gateway + a discovery index. The moat is Fangorn (C1 unlinkable settlement, C3 schema discovery, C5 agent rail).

## Positioning
- **Stripe for agent-accessible data.** Publisher wraps a dataset; agents call it and pay in USDC per access; publisher keeps the data in their own storage.
- Differentiator vs. raw x402 / Lit / API marketplaces: **payment-conditioned, unlinkable access to publisher-owned data** with on-chain settlement as the only gate, plus cross-publisher **schema discovery**.

## Personas
- **Publisher** (seller): owns a dataset (market data, embeddings, scraped corpora, curated docs). Wants per-access revenue from agents without building billing.
- **Agent / agent builder** (buyer): an autonomous agent (or its developer) that needs licensed data mid-task and can pay programmatically.

## Product surface (thin app over the SDK)
1. **Publish wizard / CLI extension** — register schema (existing `fangorn.schema.register`), point at content in R2/IPFS, set USDC price → produces a hosted **x402 endpoint URL** + an A2A AgentCard (existing `AgentCardBuilder`).
2. **x402 Gateway** (NEW, the core thin service) — an HTTP endpoint that:
   - On unpaid request → returns **HTTP 402** with x402 payment requirements (price, USDC asset, `resourceId`, settlement target).
   - On paid request → verifies Fangorn settlement (`SettlementRegistry.is_settled` via SDK), then proxies bytes from the access worker. Reuses the consumer fetch path.
3. **Discovery index** (NEW, thin) — a page + JSON/MCP endpoint listing registered schemas/datasets (from the schema registry + subgraph). Lets agents find datasets. Also exposes an MCP server so agents discover + invoke endpoints natively.
4. **Publisher dashboard** (NEW, thin) — revenue, access counts, endpoint management.

## Architecture
```
                 ┌────────────────────────────────────────────┐
   AI agent ───▶ │  x402 Gateway (Cloudflare Worker / edge)    │
   (buyer)       │   402 challenge → settle → proxy bytes      │
                 └───────────┬───────────────────┬─────────────┘
                             │ verify settlement  │ proxy
                     ┌───────▼────────┐   ┌───────▼─────────┐
                     │ Fangorn SDK    │   │ Access worker   │
                     │ Settlement/    │   │ (existing repo) │
                     │ DataSource reg │   │  R2/IPFS bytes  │
                     └────────────────┘   └─────────────────┘
   Publisher ──▶ Publish wizard ──▶ schema.register + AgentCard ──▶ Discovery index (subgraph)
```
- **Services:** x402 Gateway (stateless edge), Discovery/MCP service, Dashboard (static + thin API).
- **DB:** minimal — publisher accounts + endpoint config + analytics counters (Postgres or Cloudflare D1/KV). Settlement state stays on-chain; content stays in publisher storage.
- **Jobs/queues:** none required for MVP (settlement is on-chain pull). Optional indexer to cache subgraph for discovery.
- **Reuse:** ~70% — schema, publisher, consumer roles, registries, access worker all exist. NEW = the 402 challenge/verify wrapper, discovery/MCP surface, dashboard.

## User flows
- **Onboarding (publisher):** connect wallet → register schema → upload/point content → set price → get endpoint URL + AgentCard. (<10 min, mostly existing SDK.)
- **Activation (buyer):** agent hits endpoint → 402 → pays USDC → settles → receives data. First successful paid fetch = activation.
- **Retention:** recurring agent access to the same/related datasets; publisher adds more datasets.
- **Billing:** USDC settles on-chain to publisher; platform takes a fee (see below).

## Revenue
- **Pricing mechanics:** per-access USDC price set by publisher (SDK already supports down to 0.000001 USDC). Platform take rate **5–10%** of settlement, or flat **$29–99/mo** per publisher for hosted gateway + discovery placement.
- **Payment integration:** native USDC settlement via Fangorn; no Stripe needed for the data flow. Stripe only for the optional monthly SaaS fee.
- **Expansion:** more datasets per publisher; premium discovery placement; private/enterprise gateways; analytics tier.

## Risks
- **Technical:** x402 spec churn; settlement latency for sub-second agent calls; access-worker per-bucket limitation (multi-tenant gateway must fan out). Mitigation: cache settled-bit, support batch/prepaid access.
- **Market (PRIMARY):** *will agents actually pay yet?* Buyer-side maturity is the #1 risk. Mitigated by the validation plan (launch.md) before heavy build.
- **Legal:** publishers selling data they don't own (scraped/PII). Mitigation: ToS + schema-level provenance flag; stay infra-neutral.
- **Operational:** single founder running edge infra. Mitigation: stateless Cloudflare Workers, on-chain source of truth, minimal DB.
