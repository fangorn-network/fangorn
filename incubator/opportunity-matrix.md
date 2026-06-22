# Fangorn — Opportunity Matrix

**Lens:** Fangorn is treated as infrastructure/SDK. We want a *thin* application that monetizes its unique primitive (unlinkable, payment-conditioned access to publisher-owned data), buildable by a single founder in <10 days, validatable for <$1,000, with paying customers before scale.

## Scoring (1–5, higher = more favorable, including for "build simplicity" and "speed to revenue")

| # | Opportunity | Class | Pain | Urgency | Mkt size | Competitive position | Defensibility (SDK moat) | Distribution | Build simplicity (<10d) | Speed to revenue | Founder fit | Code leverage | **Total** |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **O1** | **AnonPay** — "Gumroad for unlinkable crypto downloads" | SaaS (thin) | 4 | 3 | 3 | 3 | 4 | 3 | 4 | 4 | 4 | 5 | **37** |
| **O3** | **x402 Paid Data** — "Stripe for agent-accessible datasets" | API / dev-tool | 4 | 4 | 4 | 4 | 4 | 3 | 3 | 3 | 4 | 4 | **37** |
| **O4** | **PaidMCP** — paywalled MCP data-source toolkit | Dev-tool / open-core | 3 | 4 | 3 | 4 | 3 | 4 | 4 | 3 | 4 | 4 | **36** |
| **O2** | **GateKit** — hosted access-worker / token-gating API | API / infra | 3 | 3 | 3 | 4 | 4 | 3 | 3 | 3 | 4 | 5 | **35** |
| **O6** | **CloseRoom** — confidential data room, unlinkable access | Enterprise / compliance | 4 | 3 | 3 | 4 | 5 | 2 | 2 | 2 | 3 | 4 | **32** |
| **O5** | **TrainFair** — AI training-data marketplace, provable licensing | Marketplace / data | 4 | 3 | 4 | 3 | 4 | 2 | 2 | 2 | 3 | 4 | **31** |
| **O7** | **SealAPI** — TEE-sealed encryption-as-a-service | API | 3 | 3 | 3 | 4 | 5 | 2 | 1 | 2 | 3 | 3 | **28** |

## The four front-runners

### O1 — AnonPay ("Gumroad for unlinkable crypto downloads")  ·  Score 37
- **User:** crypto-native creators / publishers selling files (music, model weights, PDFs, datasets, premium media).
- **Problem:** existing paywalls (Gumroad, Lemon Squeezy) link the buyer's identity/payment to the purchase, and self-hosted token-gating is fiddly. No good way to sell a file where the buyer stays *unlinkable* and the seller keeps the file in their own storage.
- **Solution:** hosted checkout + the Fangorn access worker. Creator points at an R2 object, sets a USDC price; buyer pays and downloads via the unlinkable purchase→claim→fetch flow. App layer = a checkout page + dashboard.
- **Model / pricing:** 3–5% of GMV, or $19–49/mo per seller. **Moat:** C1+C2. **Distribution:** crypto creator Twitter/X, Farcaster, NFT/music DAOs.
- **Why top:** clearest single buyer, thinnest app, fastest path to a first paying seller, maximal code reuse.

### O3 — x402 Paid Data ("Stripe for agent-accessible datasets")  ·  Score 37
- **User:** data publishers who want AI agents to pay per-access; agent builders who need licensed, machine-payable data.
- **Problem:** the agentic web has no clean, privacy-preserving "pay this endpoint and get the data" rail; x402 is nascent and unopinionated.
- **Solution:** SDK + thin hosting to expose any schema-registered dataset as an x402-priced endpoint; agents discover via the schema registry and settle via Fangorn. App layer = a publish wizard + a discovery/index page.
- **Model / pricing:** usage-based take rate on settlements; publisher subscription. **Moat:** C1+C3+C5. **Distribution:** AI-agent/MCP dev communities, x402 ecosystem.
- **Why top:** highest ceiling and most on-trend; risk is buyer-side maturity (agents paying is still early), which is the thing to validate cheaply.

### O4 — PaidMCP (paywalled MCP data-source toolkit)  ·  Score 36
- **User:** developers shipping MCP servers/tools who want to charge per call.
- **Problem:** thousands of MCP servers, ~no native monetization; devs hand-roll auth + billing.
- **Solution:** an npm package + template: wrap MCP tools so each call requires a Fangorn settlement; ship "paid MCP server in 10 minutes." Sell Pro template + hosted metering/support (open-core).
- **Model / pricing:** open-core (free SDK, paid hosting/Pro). **Moat:** C2+C5 (thinner — wrapper). **Distribution:** best of the four — MCP devs congregate, content-marketing-led, self-serve.
- **Why top:** best distribution + build simplicity; weaker defensibility because the wrapper is replicable.

### O2 — GateKit (hosted access-worker / token-gating API)  ·  Score 35
- Pure infra: multi-tenant hosted access worker; gate any R2/IPFS object behind on-chain conditions; pay per GB proxied / per settlement verified. Highest code reuse, but billing/metering + multi-tenancy is the new work, and it competes most directly with Lit Protocol.

## Excluded for now
- **O6 CloseRoom / O5 TrainFair** — strong moat and market, but enterprise/marketplace dynamics violate "paying customers before scale" and "<$1,000 validation."
- **O7 SealAPI** — depends on the unbuilt TEE; revisit once C6 is deployed.

## Recommendation
Lead with **O1 (AnonPay)** for fastest paying customer, or **O3 (x402 Paid Data)** for the largest on-trend upside. **O4 (PaidMCP)** is the best *distribution-led* wedge if the goal is developer adoption. Validate the chosen one for <$1,000 before building the thin app.
