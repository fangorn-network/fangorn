# Acceptance scenarios — contract wrappers

What the TypeScript clients in `src/contracts/` are supposed to do, written as
scenarios before the tests exist. Each one has an id (`APP-1`, `PUB-3`, …) so a
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

## A. App level — the app owner

The AppRegistry owns what an "app" is. Every call here is scoped to the client's
`appId`, which is constructor state, not an argument.

| id | scenario |
|----|----------|
| **APP-1** | **Claim an app.** `registerApp(termsHash, uri, joinFee)` reads `subscriptionFee()`, approves exactly it in USDC when the allowance is short, and sends `[appId, termsHash, uri, joinFee, fee]` — the client's own `appId` first, and the fee it read as the cap. |
| **APP-2** | **Claiming makes you your own first publisher.** After `registerApp`, `canPublish(owner)` is true with no second transaction. [contracts] — listed because a UI that walks every wallet through a join screen will hit `AlreadyJoined`; gate on `joinInfo().canPublish`. |
| **APP-3** | **Publish new terms.** `setAppTerms(hash, uri)` sends `[appId, hash, uri]`. |
| **APP-4** | **Moving the terms stops every other member.** `canPublish` is false for a publisher whose accepted hash is stale, while `statusForApp` still reads `ACTIVE`. The client must keep these distinguishable — see APP-6. |
| **APP-5** | **Set the join fee.** `setJoinFee(fee)` sends `[appId, fee]`, in USDC base units. |
| **APP-6** | **`needsReacceptance()` separates two different failures.** Given `status: ACTIVE`, `acceptedTerms !== termsHash` → true. Given `status: NONE` → false. These need different words and different buttons in a UI (`acceptUpdatedTerms` versus `joinApp`). |
| **APP-7** | **`joinInfo` decodes the tuple positionally.** A 5-tuple `[hash, uri, joinFee, status, canPublish]` becomes the named struct, `status` coerced from `number` to `PublisherStatus`. Positional decoding is the thing most likely to rot silently when the contract tuple changes, so assert every field. |
| **APP-8** | **Suspend a member.** `setPublisherSuspended(pub, bool)` sends `[appId, publisher, bool]`. Suspension is per-app: the same publisher under a different `appId` is untouched. Only joined members; never the owner. [contracts] |
| **APP-9** | **`getAppOwner` on an unclaimed id returns the zero address**, and the client returns it rather than throwing. "Unclaimed" is a legitimate answer for a directory page. |
| **APP-10** | **Renew one period.** `renewSubscription()` throws before sending when `isRenewable()` is false, and otherwise sends `[tokenId, subscriptionPeriod()]` with `tokenId = BigInt(appId)`, after approving exactly the fee: the standard has no cap argument, so the allowance is the cap. |
| **APP-11** | **Invitations can be taken back.** `invitePublisher(p)` / `revokeInvitation(p)` send `[appId, publisher]`. |

## B. Publisher level

Per-app membership and the network-wide ban both live in the AppRegistry, and
every commit goes through it to the DataRegistry.

| id | scenario |
|----|----------|
| **PUB-1** | **There is no global registration.** A wallet can claim an app, be invited to one, join and commit without any other step. The protocol admin's network-wide ban is read with `isGloballySuspended(address)`. |
| **PUB-2** | **Join an app.** `joinApp()` reads `joinInfo` immediately before sending, passes the hash it read as the argument, approves exactly the join fee it read in USDC, and passes that fee as `max_join_fee`. No ETH value. |
| **PUB-3** | **A terms change mid-flight is a revert, not a surprise agreement.** The hash is passed as an argument precisely so the contract reverts `TermsMismatch` rather than binding the publisher to a document they never saw. Assert the argument comes from the read, not from a caller parameter. |
| **PUB-4** | **Refuse to join an app with no terms.** `termsHash === 0` → the client throws before sending, naming the app. The contract would revert; failing here costs no gas and says why. |
| **PUB-5** | **Accepting moved terms is free, and separate.** A member on stale terms calls `acceptUpdatedTerms()`, which sends `[appId, appTerms()]` and no fee. `joinApp()` refuses an `ACTIVE` publisher before sending. |
| **PUB-6** | **`prepareJoinApp` returns what the wallet must sign, in order.** A USDC `approve` of exactly the join fee when the allowance is short, then the join; the join alone when it is covered or the fee is zero. |
| **PUB-7** | **A prepared transaction turns a simulated revert into a sentence.** Simulation rejecting with `/revert/i` → an error naming the function and the contract's reason. A non-revert RPC failure → fall back to a gas ceiling and proceed. A join behind an approval is not simulated: it would revert until the approval lands. |
| **PUB-8** | **Commit is compare-and-swap per namespace, through the AppRegistry.** `commitStateRoot(ns, oldRoot, newRoot)` sends `[appId, subspaceId(ns), oldRoot, newRoot]` to the AppRegistry, never the DataRegistry. Concurrent pushes to *different* namespaces do not contend. [contracts] |
| **PUB-9** | **`prepareCommitStateRoot` quotes its own gas and fees.** Assert `gas` is 1.5x the estimate and `maxFeePerGas` is 2x, both hex. Leaving these to the wallet is what surfaces as "Network fee Unavailable" in MetaMask. |
| **PUB-10** | **`namespaceKey` matches the contract.** Already pinned by `namespace-key.test.ts` against a golden fixture. Do not duplicate; do assert `commitStateRoot` derives its subspace through the same `subspaceId`. |
| **PUB-11** | **An app is its storage subscription.** `registerApp()` and `renewSubscription()` send no value — the fee is pulled in USDC, so the precondition is an ERC-20 `approve`, not attached ETH. The client approves exactly the fee when the allowance is short and skips it when the fee is zero or already covered (`app-registry.test.ts`). |
| **PUB-12** | **`access()` decodes `(bool, address, uint64)`** into `{ canPublish, owner, expiresAt }`. `owner` is the zero address and `expiresAt` 0 for an unclaimed app. |
| **PUB-13** | **Expiry is chain state.** Once `expiresAt` has passed, `canPublish` is false and commits and joins revert `SubscriptionExpired`, with no grace period. `joinApp()` checks it against block time before sending. [contracts] |
| **PUB-14** | **Membership is by invitation.** `joinApp()` throws before sending anything when the wallet's status is NONE — the owner has not called `invitePublisher`. INVITED joins and pays the join fee; ACTIVE on stale terms uses `acceptUpdatedTerms`. |
| **PUB-15** | **A banned wallet is refused everywhere.** Claiming, being invited, joining and committing revert `PublisherSuspendedGlobal`. A banned owner's app keeps running, but they cannot invite anyone or change its terms or agent card. The CLI checks `isGloballySuspended` first and says so. [contracts] |

## C. Consumer level

The SettlementRegistry (per-resource `register`/`settle`) is deprecated and its
client removed; consumer access is now the MembershipRegistry (`join`/`claim`
per app and epoch). Scenarios for it are still to be written.

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
