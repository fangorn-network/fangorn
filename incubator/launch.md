# Launch & Validation Plan — x402 Paid Data

> Buyer-side maturity ("will agents actually pay yet?") is the #1 risk. **Validate for <$1,000 before building the thin app (M1+).** M0 in build-graph.md is this plan.

## MVP (minimum sellable version)
A publisher registers one dataset and gets a live URL that:
1. returns **HTTP 402** with x402 payment requirements to an unpaid agent, and
2. returns the data bytes once the agent has paid USDC and settled on-chain (unlinkably).
Plus a one-page catalog so an agent/dev can find it. That's it — M0+M1+M2+M3+minimal M4.

## First customers (specific profiles)
- **Data publishers (sell side):** indie quant/market-data sellers; embeddings/vector-dataset authors; niche scraped-corpus owners; API authors already on RapidAPI who want per-call crypto billing; on-chain analytics shops.
- **Agent buyers (demand side):** agent-framework builders (LangGraph/AutoGPT-style), MCP tool authors, trading/research agents that already consume paid data.
- **Ideal design partner:** someone who *both* publishes data *and* knows agent builders who would consume it (closes the loop in one relationship).

## Outreach strategy (concrete channels)
- **x402 / agent-payments communities:** Coinbase x402 ecosystem, relevant Discords/Telegrams, Farcaster `/agents` & data channels.
- **MCP developer surfaces:** MCP server directories, r/LocalLLaMA, MCP Discord — offer "monetize your MCP data tool."
- **Crypto-data Twitter/X:** DM publishers selling datasets/APIs; offer to wrap one for free.
- **Direct LOIs:** 10 warm publisher conversations → 3 design partners.

## Pricing (initial)
- **Platform take:** 7.5% of USDC settlement (waive for first 3 design partners).
- **Optional SaaS:** $49/mo hosted gateway + discovery placement once value is proven.
- Publishers set their own per-access price (SDK supports 0.000001 USDC granularity).

## Validation experiments (cheap, falsifiable — total <$1,000)
| # | Experiment | Falsifies | Cost | Pass bar |
|---|---|---|---|---|
| V1 | **Scripted-agent E2E on testnet:** a bot hits 402 → pays → fetches, unattended | "the unlinkable pay-per-access loop doesn't work for a programmatic buyer" | ~$0 (testnet) | Bot completes ≥20 paid fetches with no human step |
| V2 | **Landing page + waitlist** ("Sell your dataset to AI agents, paid per call") | "publishers don't want this" | ~$50 domain + ~$200 ads | ≥25 qualified signups or ≥3 LOIs |
| V3 | **3 design-partner interviews → 1 real dataset wrapped** | "no publisher has a dataset worth wrapping" | $0 | 1 publisher agrees to a paid pilot |
| V4 | **Demand probe:** find 1 agent builder who pays for ≥1 real access on testnet/mainnet-small | "agents won't actually pay" (THE核心 risk) | <$100 mainnet USDC | ≥1 genuine paid access from a third-party agent |
| V5 | **Mainnet smoke:** one real USDC settlement end-to-end | "settlement/worker breaks under real money" | <$50 gas+USDC | 1 clean mainnet settlement + fetch |

## Success metrics (leading indicators)
- **Activation:** time-to-first-paid-fetch for a new publisher (< 1 day).
- **Demand signal:** # third-party agent accesses/week (the real risk metric — watch V4).
- **Revenue:** first non-design-partner USDC settlement; weekly settled volume.
- **Retention:** publishers adding a 2nd dataset; repeat agent access to same dataset.

## Go / no-go
Proceed to full M1–M5 build **only if V3 (a publisher will pilot) and V4 (an agent will actually pay) both pass.** If V4 fails, pivot the same SDK to **O1 AnonPay** (human buyers, no agent-maturity dependency) — the gateway/worker work carries over.
