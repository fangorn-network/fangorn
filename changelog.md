# Changelog

## Unreleased (since 2026.10.28)

Apps no longer gate anything. Records are sold one by one (or a whole repo at
a time) through the new SettlementRegistry, and paid fields are sealed so that
no server ever sees plaintext. The contracts were redeployed on Base Sepolia.

### Breaking

- **App gating removed.** An app is now just a name: owner, a curator's repo
  of citations, a payout address and an agent card.
  - Removed from `AppRegistryClient`: subscriptions (`renewSubscription`,
    `cancelSubscription`, `expiresAt`, `isRenewable`, `subscriptionFee`,
    `subscriptionPeriod`, `setSubscriptionFee`, `setSubscriptionPeriod`,
    `tokenId`, `usdc`), membership (`acceptPublisher`,
    `setPublisherSuspended`, `status`, `canPublish`, `access`, `AppAccess`),
    and network-wide bans (`isGloballySuspended`, `setGlobalSuspension`).
  - `registerApp` is free and takes no fee.
  - Added: `setCurator` / `curatorOf`, and `setPayout` / `payoutOf`. The payout
    address is where an app's referral share goes; zero pays the owner.
  - `PublisherStatus` (`src/contracts/types.ts`) is gone.
- **MembershipRegistry removed.** `MembershipRegistryClient`,
  `MEMBERSHIP_REGISTRY_ABI`, `membershipRegistryContractAddress` and
  `getMembershipRegistry()` are gone. Use the SettlementRegistry (below).
- **Reads are no longer filtered by app.**
  - `readRepo` returns the publisher's latest head, whatever app the client
    manages.
  - `appRepos()` → `repos()`.
  - `subscribeApp()` → `subscribeAll()`.
  - `appFeed()` / `AppFeed` → `feed()` / `CommitFeed`.
  - Removed from the registry: `presents`, `exclusionCount`, `exclude`,
    `restore`, `Exclusion`, `covers`, `repoExcluded` and `exclusionId`.
  - `setAppId` no longer clears the repo cache or the shared feed.
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
    - `setDisabled`, the takedown.
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
  - **Keys.** One repo key per statement, from `repoKeyFrom(secret, stmt)` or
    `newRepoKey()`. `deriveRecordKey` derives each record's key from it.
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
    reader's throwaway X25519 key. It stores nothing. Refusals throw
    `AccessError` with status 400 or 403.
  - **Buyer.** `accessMessage`, `buildAccessRequest`, `verifyAccessRequest`,
    `requestKey` and `openField`.
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
  - AppRegistry `0x197A44c42276F31DC2CeA34C138380a59A28D1C0`;
  - SettlementRegistry `0x61A5A195B54F57ada786Ba6689CdB04553cf7fBc`;
  - `appRegistryFromBlock` is now `53592845n`.

  Repos and apps from the old deployment don't carry over.
- **The package root runs in Workers and browsers.** The engine and the
  storage utilities no longer use Node's `crypto`, `Buffer`, or a
  module-level `process.env`. Only the CLI and `src/repo` use Node.
- **CLI.**
  - `app` now registers and manages a name: `claim` is free, `info` shows the
    owner, repo, payout and agent card, and `curator` and `payout` are new.
  - `accept`, `renew`, `cancel`, `suspend` and `reinstate` are gone.
  - `set-app` only chooses the app the CLI manages; reads and publishes don't
    depend on it.
- `scripts/gen-abis.sh` generates the SettlementRegistry ABI in place of the
  MembershipRegistry's, and rebuilds afterwards so deploy artifacts keep their
  bytecode. The AppRegistry and DataRegistry ABIs were regenerated.
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
  - a takedown stops key release;
  - a raised generation voids old terms.
- The anvil testbed also deploys SettlementRegistry, with the contracts
  repo's `MockUSDC` and `MockSemaphore`, and exposes `usdc`.
- The app, admin, CLI, registry and SDK suites are rewritten for apps without
  gating, relayed commits and the new commit format.
- 146 unit tests and 27 e2e tests pass. The e2e count includes the live
  read-only checks against Base Sepolia.

### Docs

- New:
  - `docs/PRODUCT.md`: the testnet product plan;
  - `docs/PLAN.md`: the Worker and SDK plan, with the formats above;
  - `docs/BACKING.md`.
- README: app gating and the Arbitrum section are removed; there are new
  sections on apps and on subscribing to every repo.
- Whitepapers:
  - WHITEPAPER_1 and its quick version are rewritten around citations and the
    update log, with new appendices on micro-commits and accountable indexers;
  - WHITEPAPER_2 gains §2.4, on referral.
