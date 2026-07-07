# Build Graph — x402 Paid Data

Goal: a sellable MVP in <10 days, single founder, agentic acceleration. Modules are sized for parallel implementation streams; reuse Fangorn SDK wherever possible.

## Modules

### M0 — Validation harness *(do FIRST, before app build — see launch.md)*
- **Deps:** none (SDK only).
- **Inputs:** one real dataset, one scripted "agent" buyer.
- **Outputs:** evidence that an agent can hit a 402, pay USDC, and fetch data end-to-end on testnet; ≥1 design partner LOI.
- **Interface:** throwaway script + landing page.
- **Test:** a scripted agent completes purchase→claim→fetch unattended; 3+ publisher interviews logged.

### M1 — x402 Gateway (CORE, new) 
- **Deps:** Fangorn SDK (consumer fetch, SettlementRegistry, DataSourceRegistry), access worker.
- **Inputs:** HTTP request for `{publisher, schema, name, field}`.
- **Outputs:** `402` challenge (x402 payment requirements) when unsettled; proxied bytes when settled.
- **Interface:** `GET /d/:publisher/:schema/:name/:field` → 402 | 200 bytes. `x402` headers: price, USDC asset, `resourceId`, settlement contract, chainId.
- **Test:** unsettled→402 with correct requirements; settled→200 correct bytes; tampered/expired signature→401. Reuses `seal`/settlement parity logic.

### M2 — Settlement verification adapter (new, thin)
- **Deps:** SDK registries.
- **Inputs:** `resourceId`, claimant address/nullifier.
- **Outputs:** boolean settled + cache TTL.
- **Interface:** `isSettled(resourceId, addr): Promise<bool>` with short cache.
- **Test:** matches on-chain `is_settled()`; cache invalidation correctness.

### M3 — Publish wizard / CLI extension (mostly reuse)
- **Deps:** `fangorn.schema.register`, `fangorn.publisher.publishRecords`, `AgentCardBuilder`.
- **Inputs:** dataset + content handles + price.
- **Outputs:** registered schema, manifest, gateway endpoint URL, AgentCard JSON.
- **Interface:** `fangorn x402 publish <dataset> -p <price>` and/or web form.
- **Test:** produces resolvable endpoint + valid AgentCard; idempotent on re-register.

### M4 — Discovery index + MCP server (new, thin)
- **Deps:** schema registry + subgraph (existing fangorn subgraph tools), M1 endpoints.
- **Inputs:** registered schemas/datasets.
- **Outputs:** JSON catalog + web page + MCP server exposing `search_datasets` / `fetch_dataset` tools to agents.
- **Interface:** `GET /catalog`, MCP tools.
- **Test:** newly published dataset appears; agent can discover→invoke via MCP and get data.

### M5 — Publisher dashboard + billing (new, thin)
- **Deps:** M1 analytics events, Stripe (optional SaaS fee only).
- **Inputs:** access events, settlement totals.
- **Outputs:** revenue/access dashboard; subscription management.
- **Interface:** web app + `GET /stats`.
- **Test:** access counts reconcile with on-chain settlements; Stripe webhook handled.

## Dependency / parallelism

```
M0 (gate) ──▶ M1 ──▶ M4
              ├─ M2 (feeds M1)
              └─ M3 (parallel to M1, depends on SDK only)
                        M5 (depends on M1 events; build last)
```
- **Critical path:** M0 → M1 (+M2) → M4 → demo.
- **Max parallelism after M0:** M1+M2, M3, and the M4 scaffolding can proceed concurrently (3 streams). M5 last.
- **Cut line for a sellable MVP:** M0 + M1 + M2 + M3 + a minimal M4 catalog. M5 dashboard and MCP polish can ship post-first-customer.
