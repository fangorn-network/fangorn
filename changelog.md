# Changelog

## Unreleased (since 2026.10.28)

There is no app registry: an app is a publisher's repo, and agent cards attach
to repos. Records are sold one by one (or a whole repo at
a time) through the new SettlementRegistry, and paid fields are sealed so that
no server ever sees plaintext. The contracts were redeployed on Base Sepolia.

### Breaking

- **AppRegistry removed.** An app is now just a publisher's repo that cites
  other repos. Removed:
  - `AppRegistryClient`, `APP_REGISTRY_ABI`, `getAppRegistry()`, and with them
    app names, claims, renames, curators, payouts, subscriptions,
    membership and admin suspension;
  - `appId` (the `Fangorn.create` option and the helper), `toAppId`,
    `getAppId`, `setAppId` and `renameApp`;
  - `appRegistryContractAddress` in the network config. `appRegistryFromBlock`
    is now `fromBlock`, the DataRegistry's deployment block, where scans of
    the update log start;
  - `discoverApp` and `FANGORN_APP_EXTENSION` (see agent cards, below);
  - `PublisherStatus` (`src/contracts/types.ts`).

  `AppConfig` is renamed `NetworkConfig`. A referral goes to whatever address
  the buyer's client names in `register`.
- **MembershipRegistry removed.** `MembershipRegistryClient`,
  `MEMBERSHIP_REGISTRY_ABI`, `membershipRegistryContractAddress` and
  `getMembershipRegistry()` are gone. Use the SettlementRegistry (below).
- **Reads aren't filtered by app.**
  - `readRepo` returns the publisher's latest head, whatever app the client
    manages.
  - `appRepos()` → `repos()`.
  - `subscribeApp()` → `subscribeAll()`.
  - `appFeed()` / `AppFeed` → `feed()` / `CommitFeed`.
  - Removed from the registry: `presents`, `exclusionCount`, `exclude`,
    `restore`, `Exclusion`, `covers`, `repoExcluded` and `exclusionId`.
- **Storage uploads aren't billed to an app.** The signed-URL backend charges
  the signing publisher's quota. It no longer sends an `appId`, and uploading
  without an app works.
- **New commit format.**
  - Commits no longer carry `message`. The `message` option is gone from
    `commit`, `prepareCommit`, `createCommit`, `log` and `show`.
  - `car` is now the CAR file's CID, not a storage URI. `putFile` must return
    a CID, with or without `ipfs://`.
  - The DataRegistry now computes the head itself from
    `(repo, epoch, parent, root, car)`. `Registry.update` and `prepareUpdate`
    take a `CommitUpdate` instead of `(repo, parent, head)`.
  - A commit built in the old format is refused at push time ("rebuild it").
- **`worker-usdc-v1` removed.** That was the gadget in which the access worker
  decrypted and returned plaintext. Removed with it:
  - `encryptAndUpload`, `decryptHandle`, `HandleFieldInput`, `DecryptHandleParams`;
  - the old `AccessRequest`, `accessMessageHash` and `buildAccessRequest`
    (nullifier and `objectKey`);
  - `sha256Hex`, `GADGET_WORKER_USDC_V1` and the `Gadget` type.

  Kept: `seal`, `unseal`, `sealSelf`, `unsealSelf` and `GADGET_SELF_HKDF_V1`.
  Paid fields use `field-v1` (below).
- **The harness is removed** (`src/harness`, its hackmd example and its
  export). Build records yourself and pass them to `commit` / `uploadBatch`.
- **`solc` is no longer a dependency.**
- **Arbitrum Sepolia** is no longer documented in the README. Its config is
  still exported, with the old contract addresses and no SettlementRegistry.

### Added

- **SettlementRegistry client** (`src/contracts/settlement-registry`, from
  `fangorn.getSettlementRegistry()`):
  - For publishers:
    - `signTerms`: EIP-712 signed terms `{ publisher, repo, key, price, shareBps, generation, deadline }`;
    - `raiseGeneration`, which voids every earlier set of terms;
    - `setDenied`, to refuse a referrer;
    - `setDisabled(repo, key, disabled)`, the takedown, for the wallet's own
      subjects only. The SDK exposes no admin takedown: moderation is off-chain.
  - For buyers, and submittable by anyone: `register` (an ERC-3009 payment plus
    a Semaphore identity commitment) and `settle` (a Semaphore proof naming
    the reader).
  - Reads: `canRead`, `isSettled`, `isRegistered`, `isDisabled`, `isDenied`
    and `generationOf`.
  - Helpers: `recordKey(id)`, `subjectOf`, `registerNonce`, `WHOLE_REPO`,
    `settlementDomain`, `TERMS_TYPES`, and `termsToJson` / `termsFromJson`
    for the `"@terms"` field a record for sale carries.
- **Paid fields (`field-v1`, `src/crypto/paid.ts`).** Everything a publisher
  sells in a repo is sealed under one statement:
  `keccak256(abi.encode("fangorn:pay:v1", chainId, settlementRegistry, publisher, repo, generation))`.
  - **Keys.** One random repo key per statement, from `newRepoKey()`.
    `deriveRecordKey` derives each record's key from it. The publisher
    doesn't keep it: they recover it from the key server with `requestKey`
    and `WHOLE_REPO`, signing with their wallet.
  - **Fields.** `encryptField` / `decryptField` use AES-256-GCM, with the
    statement, the record key and the field name as associated data.
  - **`sealField`** encrypts a field, uploads it through `putFile`, and
    returns a handle with no key material in it:
    `{ "@type": "handle", gadget, generation, cid }`.
  - **`makeDeposit`** seals the repo key to a key server once per statement.
    The deposit is committed as a public record, `@deposit/<generation>`.
  - **Key server: `serveAccess(body, { secret, chainId, registry, canRead })`.**
    This is the whole `/access` route. It recomputes the statement from its
    own chain and registry, checks the reader's signature and `canRead`, and
    returns the record key (or, for `WHOLE_REPO`, the repo key) sealed to the
    reader's throwaway X25519 key. A request signed by the publisher always
    succeeds, so publishers can recover their own keys. It stores nothing. Refusals throw
    `AccessError` with status 400 or 403.
  - **Buyer.** `accessMessage`, `buildAccessRequest`, `verifyAccessRequest`,
    `requestKey` and `openField`.
- **Agent cards on repos.** A repo's `@card` record (`CARD_RECORD`) holds the
  URL of its A2A card, and the card names the repo back in the
  `FANGORN_REPO_EXTENSION` extension: `{ chainId, dataRegistry, publisher, repo }`.
  - `discoverCard(url)` fetches a card and accepts it only if the repo's
    `@card` record points at exactly that URL;
  - `cardOf(publisher, repo)` reads the binding;
  - `setCard(repo, url)` commits it, or does nothing if it's already bound;
  - `registerAgent(url, { repo, … })` registers with ERC-8004, then calls `setCard`.
- **Relayed commits.** A publisher signs the update and anyone can submit it,
  paying the gas:
  - client: `signPush` / `relayPush`;
  - engine: `signCommit` / `relayCommit`;
  - registry: `signUpdate` / `updateBySig`;
  - shapes: `SignedUpdate`, `CommitUpdate`, `commitUpdate`, `commitHead`,
    `UPDATE_TYPES`, `dataDomain`, `updateMessage`, and `WINDOW`, the epochs a
    commit may lag the chain's clock.
- `aesGcmEncrypt` / `aesGcmDecrypt` take optional associated data.

### Changed

- **Base Sepolia contracts redeployed** (blocks 53592845–53592851):
  - DataRegistry `0x0F3eb0E62CF610dbaC6B3aD4Bf4cE38Ab50EBCC5`;
  - SettlementRegistry `0x61A5A195B54F57ada786Ba6689CdB04553cf7fBc`;
  - `fromBlock` is `53592845n`.

  Repos and apps from the old deployment don't carry over.
- **The package root runs in Workers and browsers.** The engine and the
  storage utilities no longer use Node's `crypto`, `Buffer`, or a
  module-level `process.env`. Only the CLI and `src/repo` use Node.
- **CLI.**
  - `set-app`, `--app`, `FANGORN_APP_ID`, `FANGORN_APP_REGISTRY` and every
    `app` command are gone.
  - `fangorn card <url>` binds an agent card to the tracked repo (or
    `--repo`) and registers it with ERC-8004; it takes the old
    `app agent` options.
- `scripts/gen-abis.sh` generates the DataRegistry and SettlementRegistry ABIs
  only, and rebuilds afterwards so deploy artifacts keep their bytecode.
- The `MemStorage` test backend returns real CIDs from `putFile`.

### Tests

- `src/crypto/paid.test.ts` (unit):
  - statement binding;
  - a field opens only under its own record key, statement, record and
    field name;
  - an access request fails if any field changes, on another chain or
    registry, or once stale;
  - a record buyer opens only their record;
  - a whole-repo buyer opens every record;
  - a deposit made for another repo or registry doesn't open.
- `src/e2e/paid.e2e.test.ts` (anvil, with a key server over HTTP reading
  `canRead` from the chain):
  - 403 before settling, plaintext after, 403 for another record;
  - the publisher is paid the price less the 5% referral, and the referrer
    is paid the 5%;
  - a whole-repo purchase opens every record;
  - the publisher recovers the repo key through their wallet and seals
    another record with it;
  - a takedown stops key release;
  - a raised generation voids old terms.
- The anvil testbed deploys the DataRegistry and SettlementRegistry (with the
  contracts repo's `MockUSDC` and `MockSemaphore`), no AppRegistry, and
  exposes `usdc`.
- `src/discover-card.test.ts` (unit) and `src/e2e/cards.e2e.test.ts` (anvil)
  replace the app tests: a card is found from its URL alone, and refused
  unless its repo's `@card` record points back at it. The admin suite is gone.
- The CLI, registry and SDK suites are rewritten for relayed commits and the
  new commit format.
- 128 unit tests and 19 e2e tests pass. The e2e count includes the live
  read-only check that `fromBlock` is the DataRegistry's deployment.
- One full sale was run by hand on Base Sepolia, against the deployed
  contracts. The steps were: publish a paid record, get 403, `register` with
  a real USDC ERC-3009 payment, `settle` with a real Semaphore proof,
  decrypt, check the 5% referral, and recover the publisher's key. The key
  server ran locally.

### Docs

- New:
  - `docs/PRODUCT.md`: the testnet product plan;
  - `docs/PLAN.md`: the Worker and SDK plan, with the formats above;
  - `docs/BACKING.md`.
- README:
  - removed: apps as registered names, and the Arbitrum section;
  - new sections on agent cards, on subscribing to every repo, and on commit epochs;
  - "Encryption & gadgets" rewritten for `field-v1`.
- Whitepapers:
  - WHITEPAPER_1 and its quick version are rewritten around citations and the
    update log, with new appendices on micro-commits and accountable indexers;
  - WHITEPAPER_2 gains §2.4, on referral.
