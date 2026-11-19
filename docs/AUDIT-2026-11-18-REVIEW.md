# Fangorn audit review — 2026-11-18

Scope: a review of the fixes claimed in `docs/AUDIT-2026-11-17.md`, against the code changes in commits `4d0968a` and `2eea161` (branch `feat/code-audit`, diffed from `1df8d71`). Contracts parity was checked against `fangorn-network/contracts` `feat/code-audit` (`cd5aee9`).

Method: every source change (18 non-test files) was read against its claimed finding. Library behaviour the fixes rely on was checked in the installed source (viem 2.47.1). The gates were rerun.

## A. Summary

**Follow-up status.** B1–B5 and C1 were fixed after the initial review. C2–C5 remain open. The table below records the initial checks. [Post-fix results](#f-section-b-fixes-and-verification)

Historical reads and live watches passed the checks for the release-blocking `Updated` ABI change. The remaining gaps affect staging, subscription recovery, upload verification, ERC-8004 receipt reporting, and plain-text preservation. Sections B and C describe the conditions under which each fix falls short.

| Gate               | Claimed                         | Observed                                                            |
| ------------------ | ------------------------------- | ------------------------------------------------------------------- |
| `npx vitest run`   | 38 / 270 pass                   | 38 / 270 pass                                                       |
| `npx tsc --noEmit` | clean                           | clean                                                               |
| `npx eslint src`   | clean                           | clean                                                               |
| SDK e2e on Anvil   | 64 / 66 across the full suite   | 9 / 9 across the watch, log, and paid test files                    |
| Contract tests     | 98 passed across the full suite | 21 passed, 2 opt-in skipped across the two new invariant test files |

The contracts diff from `0f178bb` through `cd5aee9` contains tests and Foundry configuration changes only. This review did not repeat the full e2e suite, the coverage campaign, or the historical Base Sepolia snapshot.

## B. Fixes that need a follow-up

### B1. Subscribe cursor: a first run can lose updates (Medium)

Location: `src/cli/cli.ts:1072` (subscribe loop). Claimed fix: "Subscribe cursor skips the rest of a block after a crash mid-block".

The new code saves a block only once a later block's change arrives. Suppose there is no cursor file yet, and a session sees changes from only one block before Ctrl-C (or SIGTERM, or a crash). Then nothing is saved. On restart, `readCursor()` returns `undefined`, which means "start live from the tip", so every push made while the subscriber was stopped is never delivered.

The code before the audit saved the cursor after the first change and didn't have this problem. The "at-least-once" claim in section D of the audit is therefore wrong for a user's first session.

Repro: run `fangorn subscribe` with no cursor file. Push one commit, then stop the subscriber. Push two more commits, then restart it: neither is delivered.

Suggested fix: on each change, save `writeCursor(change.blockNumber - 1n)` instead of tracking the previous block. The next run then resumes at the start of the current block. That is truly at-least-once and simpler.

### B2. `onSkip` can permanently drop changes when an error is temporary (Medium)

Location: `src/fangorn.ts` `readChange` (~`:956`) and `toRepoChange` (~`:993`). Claimed fix: "One unreadable log entry ends `subscribeAll` for everyone".

`readChange` catches every error, including a storage gateway timeout or an RPC hiccup, not just junk entries. Before the audit, those errors ended the stream, and `CommitFeed` reopened it and read the entry again. Now the entry is skipped.

The `onSkip` docstring says a skip "loses no changes once the repo moves on". That is only true if the stream had already read an earlier head of that repo. If the skipped entry is the first one the stream sees for a repo, `lastHead` stays unset. The next entry then diffs from its own `log.parent`, which is the skipped head, so the skipped commit's changes are never delivered. The first entry per repo is the usual case on any catch-up (`fromBlock`) or `CommitFeed` restart.

A separate recovery gap exists even when the subscriber already has a good head. To diff from that head, `eventsSince` walks the intervening commits and reads their event diffs. If an intermediate commit or diff remains unavailable, later updates to that repo can keep failing. The cited regression exercises an unreadable entry from a different publisher and establishes that other publishers continue. [Diff traversal](../src/engine/index.ts#L646) · [Subscription test](../src/audit/subscribe-poison.test.ts#L48)

Suggested fix for the first-entry case: in the catch, add `if (!lastHead.has(key)) lastHead.set(key, log.parent)` (with `key` built as in `toRepoChange`). The next diff then starts from before the skipped commit, when the intervening data becomes readable. A poisoned parent still fails, as it did before, but only for that repo.

### B3. CommitFeed can miss changes before its first delivery (Medium)

The feed records its restart block only after delivering a change. If the initial watch fails before then, the retry opens live and skips changes that landed during the retry delay. The restart regression covers a feed that has already delivered a change. [Feed restart](../src/feed.ts#L82) · [Regression test](../src/fangorn.fuzz.test.ts#L485)

### B4. Separate staging commands can silently replace a record (Medium)

The source-file map exists for one invocation of `addPaths`. If two filenames normalize to the same ID and are staged in separate commands, the second command removes the first staged record and replaces it. Staging the two files together correctly reports a collision. [Collision check and staged-record merge](../src/cli/stage.ts#L185)

### B5. Some upload paths still accept an unchecked reference (Medium)

Block uploads verify the expected raw CID. File uploads verify raw SHA-256 CIDs, but the helper returns successfully for malformed strings and other codecs. The commit engine parses the returned CAR CID separately. The paid-field writer stores the returned string directly in its handle, so publication can succeed with an unreadable ciphertext reference. ERC-8004 metadata also uses a provider upload path that returns the CID unchecked. [CID checks](../src/providers/storage/types.ts#L97) · [CAR parsing](../src/engine/index.ts#L169) · [Paid-field handle](../src/crypto/paid.ts#L221) · [Metadata upload](../src/providers/storage/pinata.ts#L38)

## C. Other gaps

### C1. Symlink escape in `fangorn add`, only partly fixed (High) — fixed

**Status:** fixed after the review. See [section G](#g-section-c-fixes-and-verification).

Location: `src/cli/stage.ts:76-91` (`walk`).

Symlinks inside a directory are no longer followed, which fixes `fangorn add .`. But if the path you name is itself a symlink to an outside directory or file (`fangorn add link-to-home`), it still gets read. `statSync` follows the link, and `top` is computed from the unresolved path, so the outside-the-repo check passes. A selected path can also have a symlinked ancestor. Either case can stage outside content for subsequent publication to IPFS. [Directory walk](../src/cli/stage.ts#L76)

Suggested fix: resolve the path with `realpathSync` before computing `top`, and check that the resolved path stays inside the resolved repo root.

### C2. Subscribe cursor path escape, containment and filter identity (Medium)

Location: `src/cli/cli.ts:1004`.

The namespace is now `encodeURIComponent`-ed, but `--owner` is interpolated into the filename without validation. `--owner ../../x` makes `path.join` resolve outside `.fangorn`. `readCursor` reads that path before anything validates the address.

There is also a collision between valid filters. For the same owner, an omitted namespace and a namespace literally named `all` produce the same cursor filename. Progress saved by one subscription can cause the other to skip unseen changes. [Cursor construction and read](../src/cli/cli.ts#L999)

Suggested fix: validate the owner and distinguish an omitted namespace from every literal namespace when constructing the cursor key.

### C3. `writeAtomic` temp file permissions (Low)

Location: `src/cli/cli.ts:81`.

`writeFileSync(tmp, …, { mode })` only applies the mode when the file is created. If a crashed run left a stale `config.json.<pid>.tmp` with looser permissions and the same pid comes up again, the key file is renamed into place as 0644. This is very unlikely.

Suggested fix: delete the temp file before writing (or open it with the `wx` flag).

### C4. ERC-8004 returns the original hash after a fee reprice (Low)

`setAgentFile` correctly rejects a cancellation or unrelated replacement. After a successful reprice, it discards the mined hash from `confirmTx` and returns the original hash, which has no mined receipt. The regression checks success or failure only. [ERC-8004 write](../src/erc8004.ts#L231) · [Regression test](../src/contracts/write.fault.test.ts#L223)

### C5. BOM handling alters plain-text records (Low)

`fileToRecords` strips a leading U+FEFF before choosing the parser. That fixes BOM-prefixed structured input but also removes the character from ordinary text that previously preserved it. [File decoding](../src/cli/stage.ts#L102)

## D. Verified behavior within the reviewed fixes

| Finding (from the 2026-11-17 audit)              | What was checked                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Updated` ABI drift                              | `log()` queries both event versions by topic. The leaf in `mmr.ts` matches `DataRegistry.sol:147-148` (`LEAF, publisher, repo_id, pos, head, timestamp`; `index` is not hashed). The new event's `timestamp` is `block.timestamp`, so skipping the block read is safe.                                                                                                                                                                                     |
| Watcher dedupe                                   | viem 2.47.1 `watchContractEvent` builds its key from `address, args, batch, uid, eventName, pollingInterval, strict, fromBlock`, with no ABI. With no `eventName`, the polling path decodes by event signature, and the websocket path emits unknown events with `eventName` unset, so the `eventName === "Updated"` filter drops them before `args` is read. Several `watch()` calls now share one poller, which is correct because each filters locally. |
| Replaced transactions                            | `confirmTx` throws on `replaced`/`cancelled`, accepts `repriced` (a speed-up), reports the mined hash, and turns a timeout into "may still land". `erc8004.ts` uses it for both writes.                                                                                                                                                                                                                                                                    |
| Zero-address placeholder                         | `assertDeployed` runs in both `sendWrite` and `prepareWrite`. `IDENTITY_REGISTRY` has no zero placeholders.                                                                                                                                                                                                                                                                                                                                                |
| `--paid --replace` drops the deposit             | The existing `@deposit/<gen>` is re-emitted. It re-encodes to the same block in a normal commit.                                                                                                                                                                                                                                                                                                                                                           |
| `push` stale parent / already up to date         | `onChainTip` returns a CID string (or null), the same format as `log()`'s `cid`. Pending commits are pushed oldest first. A tip missing from local history is reported. With no tip, the whole history is pushed.                                                                                                                                                                                                                                          |
| CommitFeed restart window                        | It resumes from the last delivered block and dedupes that block by `owner/commitCid`. The remaining gap (a failure before the first delivery restarts live) is documented in a `ponytail:` comment.                                                                                                                                                                                                                                                        |
| Cross-publisher CAR poisoning                    | When two CARs disagree on a CID, the newcomer is hash-checked at load time. A bad copy found at read time is dropped and the walk goes on.                                                                                                                                                                                                                                                                                                                 |
| Repeated subtree (exponential reads)             | `buildMst` cannot emit the same node twice for distinct keys (empty intermediate nodes point to distinct children), so rejecting repeats in `readMst`/`diffMst` is sound.                                                                                                                                                                                                                                                                                  |
| Concurrent reads                                 | `getBlock` checks the cache again after every chain step, even when the CAR was already loaded. Two reads may load one CAR twice, which is harmless.                                                                                                                                                                                                                                                                                                       |
| Upload CID check                                 | `assertStoredBlock` requires the raw-codec sibling that readers fetch. `assertStoredFile` checks single raw sha256 files and leaves dag-pb to the per-block read checks. An `AbortSignal.timeout` error and a 429/5xx status (now attached to the error) both count as temporary in `isTransientUpload`.                                                                                                                                                   |
| `init` key handling                              | It asks before overwriting, masks input with `password()`, validates the key with a regex, creates the directory 0700, and writes through a temp file and a rename.                                                                                                                                                                                                                                                                                        |
| Filename id collapse                             | `addPaths` reports two sources mapping to one id, within one `add`.                                                                                                                                                                                                                                                                                                                                                                                        |
| CSV/JSON parsing                                 | It strips the BOM, rejects unterminated quotes, duplicate columns, extra fields, non-object rows, and look-alike commit files.                                                                                                                                                                                                                                                                                                                             |
| `__proto__`/`constructor` ids, lone surrogates   | Record ids use a `Map` and `Object.fromEntries`. `assertStorable` and `isWellFormed` are used (Node ≥ 20 is required by `engines`, so this is fine).                                                                                                                                                                                                                                                                                                       |
| Non-UTF-8 repo name diverges the client log root | `logLeaf` uses the event's indexed `repo_id` when present.                                                                                                                                                                                                                                                                                                                                                                                                 |
| Reorg-removed logs                               | `removed: true` logs are filtered out in `watch()`.                                                                                                                                                                                                                                                                                                                                                                                                        |
| Non-canonical X25519 ephemeral key               | `u` is read little-endian including bit 255, then `u ≥ 2^255 − 19` is rejected. noble's `getPublicKey` always produces canonical keys, so honest ciphertexts are unaffected.                                                                                                                                                                                                                                                                               |
| In-memory registry compare-and-swap              | Everything that awaits now runs before the parent check, so the check and the write are atomic.                                                                                                                                                                                                                                                                                                                                                            |
| `dist/` tests                                    | `vitest.config.ts` excludes `dist`.                                                                                                                                                                                                                                                                                                                                                                                                                        |

## E. Recommendations at the time of review

1. Close the staging containment gap, including symlinked ancestors. Cover separate staging commands that produce the same record ID.
2. Exercise subscription recovery before the first checkpoint and across an unavailable intermediate commit. Give distinct filters separate cursors and validate the owner before reading a cursor.
3. Check CID handling at the paid-field and metadata entry points, the mined hash returned after repricing, and plain-text round trips for BOM-prefixed files.
4. Run the full e2e suite before merging. The targeted Anvil run covered watches, logs, and paid records.

## F. Section B fixes and verification

| Finding                                 | Implemented behavior                                                                                                                                                                                                                                                               | Regression coverage                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1 — CLI cursor                         | Before emitting the first change in each block, the CLI persists the preceding block number. A restart replays the interrupted block, even if the subscriber crashed during its first block. Consumers can receive a change twice.                                                 | The CLI test interrupts delivery in block zero and checks that restart delivers the rest of that block. [Cursor tests](../src/cli/cli.state.test.ts)                                                                                                                                                                                                        |
| B2 — Recovery after a skipped commit    | The subscription retains the parent of the first observed entry. After a gap, it compares the last readable state with the next readable state directly. This delivers the net changes even if an intermediate commit remains unavailable.                                         | The same-repo tests cover both a temporary read failure and a persistently missing commit followed by a readable checkpoint. [Subscription tests](../src/audit/subscribe-poison.test.ts)                                                                                                                                                                    |
| B3 — Feed restart before first delivery | `Fangorn.feed()` reads the chain tip before opening its watch and uses the following block as its initial resume point. A watch failure before the first delivery therefore preserves changes published during the retry delay.                                                    | The test fails the initial log read, publishes during the delay, and checks that the reopened feed delivers the change. [Feed recovery test](../src/audit/subscribe-poison.test.ts)                                                                                                                                                                         |
| B4 — Staging collisions across commands | The staging index stores the source filename for each record ID. Re-adding the same source is allowed. A different file claiming that ID is rejected. Older indexes remain committable, and the CLI requires an explicit action before replacing a record whose source is unknown. | CLI tests cover separate adds, preservation of the index after a collision, releasing an ID with `rm`, and committing a legacy index. [Staging tests](../src/cli/cli.state.test.ts)                                                                                                                                                                         |
| B5 — Upload references                  | Raw files are checked against their SHA-256 digest. For chunked UnixFS files, the verifier authenticates DAG-PB nodes and checks linked byte ranges against the uploaded content. Paid-field handles and ERC-8004 registration metadata are checked before publication.            | Tests cover valid and mismatched file content, an incorrect UnixFS root, a malformed ciphertext reference, and rejection of an invalid metadata CID before a transaction is sent. [Storage tests](../src/providers/storage/storage.fault.test.ts) · [Paid-field tests](../src/crypto/paid.test.ts) · [ERC-8004 tests](../src/contracts/write.fault.test.ts) |

**Post-fix verification.** All 278 SDK unit tests across 38 files passed. All 22 targeted Anvil tests across the SDK, CLI, cards, log, watch, and paid suites passed. TypeScript, ESLint, the package build, and `git diff --check` also passed. The full e2e suite was not rerun.

## G. Section C fixes and verification

| Finding                              | Implemented behavior                                                                                                                                                                                                                                                                                                                                                                                                   | Regression coverage                                                                                                                                                                                                                                                  |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 — Symlink escape in `fangorn add` | `walk()` resolves both the repo root and the selected path with `realpathSync`, then checks containment and walks the resolved path. A named symlink, or a path under a symlinked ancestor, that leads outside the repo is rejected. A symlink that stays inside the repo stages files under their real path. A repo reached through a symlinked path still works. Symlinks inside a directory are still not followed. | The walk test covers a symlinked directory, a symlinked file, and a path under a symlinked ancestor (all rejected), plus an inside link and a symlinked repo root (both accepted). The test fails with the fix reverted. [Walk tests](../src/cli/stage.fuzz.test.ts) |

**Post-fix verification.** All 279 SDK unit tests across 38 files passed. TypeScript, ESLint and Prettier (on the changed files) were clean. The e2e suite was not rerun.
