# Acceptance scenarios — contract wrappers

What the TypeScript clients in `src/contracts/` are supposed to do, written as
scenarios before the tests exist. Each one has an id (`PUB-7`, `CO-3`, …) so a
test can name the scenario it covers and a gap is visible as an id with no test.

## What these tests prove, and what they don't

These are **wrapper** tests. They mock `PublicClient` / `WalletClient` and assert
on what the client *sends* and how it *interprets* what comes back. They prove:

- the right function name, argument order, and argument shape reach the chain
- USDC fees are approved, and passed as caps, where they must be
- reads are decoded into the right TypeScript shape
- the client fails early and legibly where it can, instead of forwarding a revert

They cannot prove the contract accepts the call. Contract behaviour is already
covered by the Forge tests in `contracts/solidity/test/` (`forge test`), and the
two suites meet only in the e2e suites, on a fork of the live chain. When a scenario below
restates a contract rule, it is because the *client* has to encode or anticipate
that rule — not to re-test it.

A scenario tagged **[contracts]** is asserted on the contract side and listed here only
for context; do not write a wrapper test for it.

## Mocking approach

One shared fake in `src/contracts/test-helpers.ts`:

- `mockPublicClient(reads)` — `readContract` resolves from a `functionName → value`
  map, and records every call. `estimateContractGas` / `estimateFeesPerGas` /
  `estimateGas` return fixed values so gas maths is assertable, not incidental.
- `mockWalletClient()` — `writeContract` records `{ functionName, args, value }`
  and returns a fixed hash; `waitForTransactionReceipt` resolves immediately.
- Unset reads **throw** rather than returning `undefined`. A client that reads
  something the test did not anticipate should fail loudly; silent `undefined`
  flows on as a zero address or a `0n` fee and the assertion still passes.

No chain, no anvil, no fixtures beyond these two.

---

## A. Publisher level

There is no app registry and no protocol-level ban; commits go straight to the
DataRegistry and name no app.

| id | scenario |
|----|----------|
| **PUB-7** | **A prepared transaction turns a simulated revert into a sentence.** Simulation rejecting with `/revert/i` → an error naming the function and the contract's reason. A non-revert RPC failure → fall back to a gas ceiling and proceed. A write behind an approval is not simulated: it would revert until the approval lands. |
| **PUB-8** | **An update is compare-and-swap per repo, on the DataRegistry.** `update(repo, parent, head)` keys the head by `(sender, repoId(repo))` and names no app; concurrent pushes to *different* repos do not contend. [contracts] |
| **PUB-9** | **`prepareCommitStateRoot` quotes its own gas and fees.** Assert `gas` is 1.5x the estimate and `maxFeePerGas` is 2x, both hex. Leaving these to the wallet is what surfaces as "Network fee Unavailable" in MetaMask. |
| **PUB-10** | **`repoId` matches the contract.** Pinned by `repo-id.test.ts` against a golden fixture. Do not duplicate. |

## B. Consumer level

Consumer access is the SettlementRegistry (`register` / `settle` per subject),
covered by `settlement-registry.test.ts`. Scenarios for it are still to be written.

## C. Coordinator — `fangorn.ts`

| id | scenario |
|----|----------|
| **CO-3** | **Clients are constructed from one config object**, so a half-configured `Fangorn` cannot exist with one registry live and another at the zero address. Currently unenforced — see the gaps below. |

## D. Known wrapper gaps

Contract functions with no client method, found by diffing each `abi.ts` against
its `index.ts`. Not bugs; decide each one deliberately rather than by omission.

| contract | missing | note |
|----------|---------|------|
| DataRegistry, SettlementRegistry | `setAdmin`, `upgradeToAndCall` | Admin-only. Deliberately unwrapped: the SDK has no admin surface, and moderation is off-chain. Upgrades go through the contracts repo's scripts. |
