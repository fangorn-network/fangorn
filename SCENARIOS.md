# Acceptance scenarios — contract wrappers

What the TypeScript clients in `src/contracts/` are supposed to do, written as
scenarios before the tests exist. Each one has an id (`APP-1`, `PUB-3`, …) so a
test can name the scenario it covers and a gap is visible as an id with no test.

## What these tests prove, and what they don't

These are **wrapper** tests. They mock `PublicClient` / `WalletClient` and assert
on what the client *sends* and how it *interprets* what comes back. They prove:

- the right function name, argument order, and argument shape reach the chain
- values (join fees, registration fees) are attached where they must be
- reads are decoded into the right TypeScript shape
- the client fails early and legibly where it can, instead of forwarding a revert

They cannot prove the contract accepts the call. Contract behaviour is already
covered by the Rust unit tests in `contracts/*/src/lib.rs` (`cargo test`), and the
two suites meet only in `e2e.test.ts` against a live chain. When a scenario below
restates a contract rule, it is because the *client* has to encode or anticipate
that rule — not to re-test it.

A scenario tagged **[rust]** is asserted on the contract side and listed here only
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

## A. App level — the app owner

The AppRegistry owns what an "app" is. Every call here is scoped to the client's
`appId`, which is constructor state, not an argument.

| id | scenario |
|----|----------|
| **APP-1** | **Claim an app.** `registerApp(termsHash, uri, fee)` sends `registerApp` with `[appId, termsHash, uri, fee]` — the client's own `appId` first, never one the caller passed. |
| **APP-2** | **Claiming makes you your own first publisher.** After `registerApp`, `isRegisteredForApp(owner)` is true with no second transaction. [rust] — listed because a UI that walks every wallet through a join screen will now hit `AlreadyRegistered`; gate on `joinInfo().registered`. |
| **APP-3** | **Publish new terms.** `setAppTerms(hash, uri)` sends `[appId, hash, uri]`. |
| **APP-4** | **Moving the terms unregisters everyone else.** `isRegisteredForApp` is false for a publisher whose accepted hash is stale, while `statusForApp` still reads `ACTIVE`. The client must keep these distinguishable — see APP-6. |
| **APP-5** | **Set the join fee.** `setAppFee(fee)` sends `[appId, fee]`. |
| **APP-6** | **`needsReacceptance()` separates two different failures.** Given `registered: false`, `status: ACTIVE`, `acceptedTerms !== termsHash` → true. Given `status: UNREGISTERED` → false. These need different words and different buttons in a UI; a bare "not registered" conflates "your terms are out of date" with "you never joined". |
| **APP-7** | **`joinInfo` decodes the tuple positionally.** A 5-tuple `[hash, uri, fee, status, registered]` becomes the named struct, `status` coerced from `number` to `PublisherStatus`. Positional decoding is the thing most likely to rot silently when the contract tuple changes, so assert every field. |
| **APP-8** | **Eject a publisher.** `suspendForApp(pub)` / `reinstateForApp(pub)` send `[appId, publisher]`. Suspension is per-app: the same publisher under a different `appId` is untouched. [rust] |
| **APP-9** | **`getAppOwner` on an unclaimed id returns the zero address**, and the client returns it rather than throwing. "Unclaimed" is a legitimate answer for a directory page. |

## B. Publisher level

Two registries in sequence: global standing in the DataRegistry, then per-app
membership in the AppRegistry. `commitStateRoot` cross-calls the second.

| id | scenario |
|----|----------|
| **PUB-1** | **Register globally.** `register()` reads `registrationFee()` first and attaches it as tx value. A caller who supplies the fee can supply the wrong one, so the client never accepts it as an argument. |
| **PUB-2** | **Join an app.** `registerForApp()` reads `joinInfo` immediately before sending, passes the hash it read as the argument, and attaches the fee it read as tx value. |
| **PUB-3** | **A terms change mid-flight is a revert, not a surprise agreement.** The hash is passed as an argument precisely so the contract reverts `TermsMismatch` rather than binding the publisher to a document they never saw. Assert the argument comes from the read, not from a caller parameter. |
| **PUB-4** | **Refuse to join an app with no terms.** `termsHash === 0` → the client throws before sending, naming the app. The contract would revert `TermsNotSet`; failing here costs no gas and says why. |
| **PUB-5** | **Re-accepting moved terms is free.** The contract charges the join fee only on first join, so an already-`ACTIVE` publisher re-accepting sends `value: 0`. The client reads the fee from `joinInfo` and must not attach it unconditionally. [rust for the pricing, wrapper for the value it sends] |
| **PUB-6** | **`prepareRegisterForApp` carries the fee.** The returned unsigned tx has a hex `value` equal to the join fee. Omitting it is a `JoinFeeRequired` revert *after* the user has clicked sign — the worst place to discover it. |
| **PUB-7** | **`prepareRegisterForApp` turns a simulated revert into a sentence.** `estimateGas` rejecting with `/revert/i` → an error naming the likely causes (already registered, suspended). A non-revert RPC failure → fall back to a `1_000_000n` gas ceiling and proceed, because an RPC hiccup is not a rejection. |
| **PUB-8** | **Commit is compare-and-swap per namespace.** `commitStateRoot(ns, oldRoot, newRoot)` sends `[appId, subspaceId(ns), oldRoot, newRoot]`. Concurrent pushes to *different* namespaces do not contend. [rust] |
| **PUB-9** | **`prepareCommitStateRoot` quotes its own gas and fees.** Assert `gas` is 1.5x the estimate and `maxFeePerGas` is 2x, both hex. Leaving these to the wallet is what surfaces as "Network fee Unavailable" in MetaMask. |
| **PUB-10** | **`namespaceKey` matches the contract.** Already pinned by `namespace-key.test.ts` against a golden fixture shared with the Rust test. Do not duplicate; do assert `commitStateRoot` derives its subspace through the same `subspaceId`. |
| **PUB-11** | **Storage subscription.** `subscribe()` sends no value — the fee is pulled in USDC, so the precondition is an ERC-20 `approve`, not attached ETH. A missing allowance reverts `SubscriptionFeeRequired`, which reads like a pricing error and is really an allowance one; the wrapper should say so when it surfaces. |
| **PUB-12** | **`access()` decodes `(bool, uint64)`** into `{ registered, paidAt }` with `paidAt` widened to `bigint`. |
| **PUB-13** | **`isActiveAt` is policy, not chain state.** Registered + `paidAt > 0` + `now < paidAt + window` → true. Assert each of the three falsifies it alone, and that `now` is injectable so a caller can use block time rather than wall-clock skew. The contract deliberately stores no expiry. |

## C. Consumer level

The thinnest-covered side today, and the reason `settle`/`register` were added to
the wrapper. The privacy property lives in the *separation* of the two calls.

| id | scenario |
|----|----------|
| **CON-1** | **Discover what a resource costs.** `getResource(id)` fans out five reads into one struct. An unlisted resource returns `owner === 0x0` rather than throwing — `getPrice` alone cannot tell "free" from "does not exist", and both are `0`. |
| **CON-2** | **`getPrice === 0` means free**, and the access worker lets a signed request through without settlement. |
| **CON-3** | **Pay.** `register(id, commitment, auth)` flattens `TransferAuthorization` into the contract's 10 positional arguments in exactly the order `[resourceId, identityCommitment, from, amount, validAfter, validBefore, nonce, v, r, s]`. This is the single most error-prone call in the SDK — a transposed `r`/`s` or `validAfter`/`validBefore` is a signature failure with no useful message. Assert the full array. |
| **CON-4** | **`register` sends no ETH value.** The USDC moves via the EIP-3009 authorization, not from `msg.sender`, which is exactly what makes the call safe to relay and the consumer gasless. |
| **CON-5** | **Read.** `settle(id, stealthAddress, proof, hookData)` flattens `SemaphoreProof` to `[resourceId, stealthAddress, merkleTreeDepth, merkleTreeRoot, nullifier, message, points, hookData]`, with `points` an 8-element array passed through intact. |
| **CON-6** | **`hookData` defaults to `[]` and is `uint8[]`, not `bytes`.** The contract declares `Vec<u8>`; every byte costs a 32-byte calldata slot. Assert the default is empty. |
| **CON-7** | **Access is checked against the stealth address, not the payer.** `isSettled(stealthAddress, resourceId)`. A test that passes the payer address here would pass against a mock and fail against a chain, so assert the argument *order* explicitly. |
| **CON-8** | **Settling twice is refused.** The proof's nullifier makes it once-per-identity; a second `settle` reverts `AlreadySettled`. [rust] |
| **CON-9** | **A disabled resource blocks new registrations but not existing access.** `isDisabled` is true, `isSettled` still true for whoever already paid. Disabling is delisting, not revocation — anyone who paid keeps what they bought. [rust] |
| **CON-10** | **Read-only construction.** A client built with no `walletClient` answers `isSettled` / `getPrice` (the access worker's whole usage) and throws a named error on any write, rather than a `TypeError` on `undefined`. |

## D. Coordinator — `fangorn.ts`

| id | scenario |
|----|----------|
| **CO-1** | **`setAppId` moves every app-scoped client together.** After `setAppId(x)`, both `getDataRegistry().getAppId()` and `getAppRegistry().getAppId()` return `x`. A DataRegistry pointed at one app while the AppRegistry answers for another means membership is checked against the wrong market — and it surfaces as a revert at commit time, far from the cause. |
| **CO-2** | **`toAppId` accepts both forms.** A 32-byte hex string passes through; anything else is `keccak256(toHex(name))`. |
| **CO-3** | **Clients are constructed from one config object**, so a half-configured `Fangorn` cannot exist with one registry live and another at the zero address. Currently unenforced — see the gaps below. |

## E. Known wrapper gaps

Contract functions with no client method, found by diffing each `abi.ts` against
its `index.ts`. Not bugs; decide each one deliberately rather than by omission.

| contract | missing | note |
|----------|---------|------|
| AppRegistry | `admin`, `statusForApp`, `withdrawEth` | `statusForApp` is reachable via `joinInfo`. `withdrawEth` is a rescue path for stuck ETH. |
| DataRegistry | `seedNamespaceHead`, `setAppRegistry` | Both are migration tools for the AppRegistry redeploy — `seedNamespaceHead` restores heads that would otherwise read empty. Needed before that deploy, not after. |

Also unwired, and the reason `config.ts` is the next step rather than this one:
`settlementRegistryContractAddress` and `subscriptionRegistryContractAddress` do
not exist in `AppConfig`, and `appRegistryContractAddress` is still the zero
address. Neither new client is constructed in `fangorn.ts` yet.
