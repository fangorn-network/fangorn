# Fangorn SDK

Fangorn is a "git for data" protocol. Publishers commit to version-controlled "repos": data stored as a Merkle search tree in IPFS, with each repo's head cyrptographically anchored on chain. It facilitates 

A **repo** belongs to its publisher, keyed **`publisher : repo`**. Its state is a map of **records** (`{ id, type, payload }`, content-addressed), and its head is the digest of the latest commit block. Any wallet can update its own repos; updating a head is a compare-and-swap on the parent (i.e. a git ref update).

An **app** is just a repo: a publisher's view of other repos, made of records that cite other publishers' records at named heads. There is no app registry. An app's publisher address is its identity and where its referral share is paid, and an agent card attaches to the repo (see [Agent cards](#agent-cards)). An app selects and arranges data; it never holds or admits it.

**Version Control**

Repos are versioned like git. Each update is a **commit** that points at its parent (previous state) and at a single **CAR file** (a packfile) holding only the blocks that were introduced in the commit. The on-chain data registry stores the head of each repo, with full history living in IPFS. Full history is reconstructible from the on-chain head without an indexer.

- `commit` (local) builds the new state in memory and persists it in two uploads, one CAR (the data) + one small commit block.
- `push` (remote) moves the on-chain head to the latest staged commit

> Since commits and records are native IPLD links, the DAG (directed acyclic graph) is easily 'diffable' and verifiable from the head stored on-chain, though it is not easily queryable (see: [quickbeam](https://github.com/fangorn-network/quickbeam))

**Storage**

Repos are stored in IPFS. The SDK currently expects Pinata to be used to ensure data availability, which will be relaxed in the future.

#### What it is not

This is not a graph database. There is no query langauge here and there is no native indexer.

## Supported Networks
---

## Installation

```sh
npm i @fangorn-network/sdk
```

---

## CLI Quickstart

```sh
npm i -g @fangorn-network/sdk
fangorn init
```

`fangorn init` prompts for:

- Wallet private key
- Pinata JWT + gateway URL (content + commit-object storage; both optional)
- Access-gating worker URL (optional — stores sealed ciphertext and enforces the read gate)
- Presigned-URL worker URL (optional — issues short-lived Pinata upload URLs so no JWT is needed)

Config is written to `~/.fangorn/config.json`.

You can also configure via environment variables (these take precedence over the config file):

```sh
ETH_PRIVATE_KEY=0x...
PINATA_JWT=...
PINATA_GATEWAY=https://your-gateway.mypinata.cloud
CHAIN_NAME=baseSepolia   # the default; or arbitrumSepolia
SIGNED_URL_WORKER_URL=https://pinata-url-provider.your-subdomain.workers.dev   # optional; defaults to the network's hosted worker
```

> The **access worker** and the **presigned-URL worker** are two different services: the first gates reads of sealed fields, the second hands out Pinata upload URLs. Don't conflate them.

### Check your wallet

```sh
fangorn wallet show            # address, public key, balance, network
fangorn wallet show --reveal   # also prints the PRIVATE key — it grants full control
```

The private key is never printed without `--reveal`: terminal scrollback, shell
logs and screen shares all outlive the command.

Hosted uploads (`storage: { signedUrl: {} }`, through the network's worker,
`config.signedUrlWorker`) count against the signing publisher's storage quota.

### Track a repo

`repo init` creates the repo with an empty first commit, pushes it, and starts tracking it in a local `.fangorn/` pointer file (just a HEAD ref — there is no local object store; commit objects and their CARs live in IPFS).

```sh
# Create the repo on-chain (no-op if it already exists) and track it here
fangorn repo init rusty-anchor
```

### Commit → push

`commit` puts and deletes a repo's records in a new commit (one CAR upload to IPFS, advances your local HEAD) — it does **not** touch the chain. `push` fast-forwards the on-chain head to your local tip.

```sh
# Stage records into a new local commit — does NOT push
fangorn commit records.json

# Settle the local tip on-chain (permission + fast-forward checked here)
fangorn push
fangorn push --force        # push even if it doesn't fast-forward the on-chain tip
```

`records.json` lists the records to put (an `id` is generated when omitted, and an existing `id` is overwritten) and the ids to delete:

```json
{
	"records": [
		{ "id": "t1", "type": "track", "payload": { "title": "Locura", "artist": "Alice" } },
		{ "id": "a1", "type": "artist", "payload": { "name": "Alice" } }
	],
	"deletes": ["t0"]
}
```

#### Epochs

Every commit carries an **epoch**: the hour it was made, as
`floor(unix seconds / 3600)` (`EPOCH_SECONDS`, `epochOf`). `commit` reads it
from the chain's latest block. The DataRegistry accepts a push only if the
commit's epoch is no more than 24 epochs (`WINDOW`, so a day) behind the
current block's, and isn't ahead of it. Any other push reverts with `EpochOutOfWindow`, and you make
the commit again.

The epoch exists for two reasons:

- **A commit can't be replayed late.** Whoever submits your signed commit,
  such as a relayer or a sequencer, can delay it but can't land it more than a
  day after you made it. Without an epoch, a commit you signed and then
  abandoned could be pushed at any time, as long as its parent was still the
  head.
- **It dates the commit.** The epoch is part of the head the registry stores
  (it is hashed with the parent, root and CAR), so anyone reading a head
  knows, to within the window, when the publisher made it. This doesn't depend
  on any indexer or timestamp service.

The window is a day rather than an exact match because you can't choose when a
transaction is included. Requiring an exact match would reject every push that
crossed an hour boundary. The full argument is in
[WHITEPAPER_1](docs/WHITEPAPER_1.md) §3.2, under "Commit epochs".

Each commit records its parent, so history is real and walkable. By default a commit is **additive** (the staged records join the repo's existing contents); pass `--replace` for snapshot semantics, where the file _is_ the repo's new state and anything omitted is removed — earlier history is retained either way. Blocks are content-addressed, so unchanged records are reused byte-for-byte across commits and never re-uploaded.

### Builders

Turning your source data into records is application logic: build the records yourself and pass them to `commit` / `uploadBatch`.

### Inspect

```sh
fangorn status              # local tip vs on-chain tip
fangorn log                 # walk commit history from the tip (newest first)
fangorn log -n 5            # limit
fangorn show                # the tip commit + what it changed vs its parent
fangorn show <commitCid>    # a specific commit

# List every record in a repo, as JSON
fangorn read                          # defaults to the current repo + owner
fangorn read rusty-anchor --owner 0x... --pretty
```

### Clone

Reconstruct tracking of a published repo from its on-chain head alone. History and contents are then fetched on demand from IPFS.

```sh
fangorn clone <owner> rusty-anchor
fangorn clone <owner> rusty-anchor --dir ./somewhere
```

### Subscribe (light client)

Watch a repo for on-chain updates and stream the diffs — **no subgraph, no
indexer**. Each `publisher:repo` pair is its own timeline, and the registry's
`Updated` event indexes both, so this reads exactly that timeline straight from
the RPC node and, for each new head, diffs the repo's records against the
previous one. Each push's
blocks arrive as one CAR download, resolved from IPFS on demand.

```sh
# Watch the current repo; each change is one JSON line on stdout.
fangorn subscribe

# Watch any publisher's repo explicitly.
fangorn subscribe rusty-anchor --owner 0x...

# Feed an embeddings/index builder directly.
fangorn subscribe rusty-anchor --owner 0x... | my-index-builder
```

Each emitted line is a repo change:

```jsonc
{
	"repo": "rusty-anchor",
	"owner": "0x...",
	"commitCid": "bafy...", // the new on-chain head
	"oldRoot": "0x...",
	"newRoot": "0x...",
	"blockNumber": "12345678", // persist this to resume
	"puts": [
		{ "id": "t1", "cid": "bafy...", "type": "track", "payload": { "title": "Locura" } },
	],
	"deletes": ["t0"],
}
```

`fangorn subscribe --all` watches every repo instead; a repo name or `--owner` narrows it.

**Resumability.** The last processed block is saved to
`.fangorn/subscribe-<owner>-<repo>.json` after each change, so restarting
replays only what you missed (via `eth_getLogs`) before going live. Override or
reset:

```sh
fangorn subscribe --from-block 12000000   # replay from a specific block
fangorn subscribe --from-start            # replay the repo's full history
```

Without a saved cursor, subscribe starts **live from the current tip** — seed
your initial index from `fangorn read` first, then subscribe for the deltas.

---

## SDK Usage

### Initialization

`Fangorn.create` is synchronous. Pass Pinata storage for any commit/read operation. Supply either a `privateKey` (the SDK builds the wallet client for you) or your own viem `walletClient`.

```ts
import { Fangorn, FangornConfig } from "@fangorn-network/sdk";

const fangorn = Fangorn.create({
	privateKey: "0x...",
	storage: {
		pinata: {
			jwt: process.env.PINATA_JWT!,
			gateway: process.env.PINATA_GATEWAY!,
		},
	},
	config: FangornConfig, // the default, Base Sepolia
});
```

### Repos & the git-native flow

`initRepo` creates a repo with an empty first commit (idempotent). Then split building from settling:
`commit` writes a commit object (durable in IPFS, HEAD not yet on-chain), and
`push` fast-forwards the on-chain head to it.

```ts
// Create the repo (no-op if it already exists)
await fangorn.initRepo("rusty-anchor");
let tip = await fangorn.onChainTip(fangorn.getAddress(), "rusty-anchor");

const c1 = await fangorn.commit({
	repo: "rusty-anchor",
	parent: tip!,
	records: [
		{ id: "t1", type: "track", payload: { title: "Locura", artist: "Alice" } },
		{ id: "a1", type: "artist", payload: { name: "Alice" } },
	],
});
await fangorn.push("rusty-anchor", c1.commitCid);

// A follow-up commit builds on the previous one
const c2 = await fangorn.commit({
	repo: "rusty-anchor",
	parent: c1.commitCid,
	records: [{ id: "t2", type: "track", payload: { title: "Otra", artist: "Alice" } }],
	deletes: ["a1"],
});
await fangorn.push("rusty-anchor", c2.commitCid); // the chain rejects it unless the parent is the current head
```

### History, diff & read

Walk history from the on-chain tip (IPFS only, no indexer), and read the current contents:

```ts
const tip = await fangorn.onChainTip(fangorn.getAddress(), "rusty-anchor");

// Walk commits, newest first
for await (const c of fangorn.log(tip!)) {
	console.log(c.cid, c.epoch);
}

// What a commit changed vs. its parent ({ puts, deletes })
const diff = await fangorn.show(tip!);

// Every record currently in one of your repos
const { records } = await fangorn.inspectRepo("rusty-anchor"); // { id, cid, type, payload }[]

// Someone else's repo, at its latest head
const { tip: head, contents } = await fangorn.readRepo("0x...", "rusty-anchor");
```

### Immediate-write helpers

For the common "stage and settle in one shot" case, `upload` (one record) and `uploadBatch`
(many records, plus deletes) run the whole commit-and-push atomically:

```ts
await fangorn.upload("rusty-anchor", { title: "Locura" }, "track");

await fangorn.uploadBatch(
	"rusty-anchor",
	[{ id: "t1", type: "track", payload: { title: "Locura" } }],
	["t0"], // ids to delete
);
```

### Subscribe (light client)

`subscribe` is an async generator over one repo's changes. It optionally
replays from a block cursor (`fromBlock`) and then watches live until the
`AbortSignal` fires. Each change carries `blockNumber` — persist it to resume.

```ts
const controller = new AbortController();

for await (const change of fangorn.subscribe({
	repo: "rusty-anchor",
	owner: "0x...", // defaults to your own address
	fromBlock: savedCursor, // omit to start live from the current tip
	signal: controller.signal,
})) {
	for (const r of change.puts) index.upsert(r.id, r.payload);
	for (const id of change.deletes) index.remove(id);
	persistCursor(change.blockNumber);
}
```

The pure diff primitive is also exposed on the engine —
`engine.repoDiff(oldRootHex, newRootHex)` — if you want to diff
two arbitrary roots without watching.

### Subscribe to every repo

Every update lands under `publisher:repo`, and each pair is its own on-chain
timeline. `subscribeAll` yields the same `RepoChange` values as `subscribe`, from
every publisher; `feed()` shares one such stream among many consumers.

```ts
for await (const change of fangorn.subscribeAll({ signal: controller.signal })) {
	console.log(change.owner, change.repo, change.puts.length);
}

// Narrow it: every publisher's "reviews" repo, or one publisher's repos
fangorn.subscribeAll({ repo: "reviews" });
fangorn.subscribeAll({ owner: "0x..." });

// Every repo's latest head, from one scan of the update log
await fangorn.repos({ repo: "reviews" });
```

### Agent cards

A repo can have an A2A agent card, so agents can find it. The binding is a
record in the repo, `@card`, holding `{ url }`. Only the publisher can commit
it. The card names the repo back, in the `FANGORN_REPO_EXTENSION` extension:

```jsonc
{
	"name": "Picks",
	"description": "…",
	"capabilities": {
		"extensions": [{
			"uri": "https://fangorn.network/a2a/repo/v1",
			"params": { "chainId": 84532, "dataRegistry": "0x…", "publisher": "0x…", "repo": "picks" }
		}]
	}
}
```

```ts
// Commit `@card`, and register the card with the ERC-8004 identity registry
// (skipRegister: true only commits the record).
await fangorn.registerAgent(cardUrl, { repo: "picks" });

// A reader holding only the URL: fetches the card, reads the repo's `@card`
// record, and refuses the card unless it points back at exactly this URL.
const { card, publisher, repo } = await fangorn.discoverCard(cardUrl);
```

From the CLI, `fangorn card <url>` does the same for the repo tracked in the
current directory, or for the one given with `--repo`.

### Storage

Fangorn operates on a 'Bring Your Own Storage' basis. Each commit is persisted as
one CAR file (an opaque packfile of the commit's new blocks) plus one small commit
block, pinned to IPFS via Pinata; the chain holds only the 32-byte commit pointer.
The backend never needs to understand IPLD — any blob store can implement the
`MetadataStorage` interface.

---

## Encryption & gadgets

Not every field belongs in public IPFS. Fangorn lets you **seal** a value and commit
only an opaque reference to it, keeping the repo — its records, their ids and types, their
addressability — fully public while the payload stays closed.

A **gadget** names _how_ a value is sealed and _under what condition_ it opens. Two
ship today, both exported from the package root (`@fangorn-network/sdk`):

| Gadget         | Key                                      | Who can open it                                                                  |
| -------------- | ---------------------------------------- | -------------------------------------------------------------------------------- |
| `self-hkdf-v1` | HKDF from your own 32-byte secret        | Only you. No recipient, no server.                                               |
| `field-v1`     | a random repo key, held by a key server  | Anyone who has paid for the record (or the whole repo) in the SettlementRegistry |

### `self-hkdf-v1` — fully private

The simplest path is entirely out of band: seal before ingestion, unseal after
retrieval. Fangorn never sees plaintext or a key — it commits the ciphertext like any
other payload. No worker, no settlement, no R2 involved.

```ts
import {
	sealSelf,
	unsealSelf,
	GADGET_SELF_HKDF_V1,
} from "@fangorn-network/sdk";
import { keccak256, stringToBytes, hexToBytes, bytesToHex } from "viem";

const ownSecret = hexToBytes(privateKey); // your own 32 bytes
const resourceId = keccak256(stringToBytes("rusty-anchor:secret-msg"));

const ciphertext = sealSelf(
	new TextEncoder().encode("the eagles are coming"),
	ownSecret,
	resourceId,
);

// commit the opaque bytes like anything else
await fangorn.upload(
	"rusty-anchor",
	{
		gadget: GADGET_SELF_HKDF_V1,
		resourceId,
		ciphertext: bytesToHex(ciphertext),
	},
	"secret-msg",
);

// later, after `read` / `inspectRepo` hands the payload back:
const plaintext = unsealSelf(
	hexToBytes(stored.ciphertext),
	ownSecret,
	stored.resourceId,
);
```

### `field-v1`: paid fields

A paid field is encrypted in the publisher's client and uploaded as a
ciphertext. The record carries a **handle** in its place, along with the
signed terms of sale. No server ever sees the plaintext.

**Keys.** Each repo has one random repo key per *generation* (see
`raiseGeneration`). Every record's key is derived from it, so selling one
record reveals nothing about the others. The publisher seals the repo key to a
**key server** once, and commits the result as a public record,
`@deposit/<generation>`. After a buyer pays, the key server releases the key:
the record key for a record purchase, the repo key for a whole-repo purchase.
It is sealed to a throwaway key the buyer generates for the request. The key
server stores nothing and checks `canRead` on the SettlementRegistry for every
request.

Everything is bound to one statement:
`(chainId, settlementRegistry, publisher, repo, generation)`. A key or
deposit made for one repo, deployment or generation never opens another.

**Publishing:**

```ts
import { x25519 } from "@noble/curves/ed25519";
import { makeDeposit, newRepoKey, recordKey, repoId, sealField, termsToJson } from "@fangorn-network/sdk";

const settlement = fangorn.getSettlementRegistry();
const repo = repoId("rusty-anchor");
const scope = {
	chainId: fangorn.getConfig().chain.id,
	registry: settlement.getAddress(),
	publisher: fangorn.getAddress(),
	repo,
	generation: await settlement.generationOf(fangorn.getAddress(), repo),
};

const kRepo = newRepoKey(); // no need to keep it, see below
const deposit = makeDeposit({ kRepo, keyServerPubkey, keyServer: KEY_SERVER_URL, scope });

const body = await sealField({
	plaintext: new TextEncoder().encode("the eagles are coming"),
	kRepo,
	scope,
	key: recordKey("a"),
	field: "body",
	storage: fangorn.getStorage(),
});
const terms = await settlement.signTerms({ repo, key: recordKey("a"), price: 10_000n, shareBps: 500, deadline });

await fangorn.uploadBatch("rusty-anchor", [
	{ id: "a", type: "note", payload: { title: "a paid note", body, "@terms": termsToJson(terms) } },
	{ id: `@deposit/${deposit.generation}`, type: "deposit", payload: deposit },
]);
```

The handle holds no key material:

```json
{ "@type": "handle", "gadget": "field-v1", "generation": "0", "cid": "bafy…" }
```

To seal more records later, the publisher gets the repo key back from the key
server by signing with their own wallet. A request signed by the publisher is
always served:

```ts
const kRepo = await requestKey({ deposit, key: WHOLE_REPO, signer });
```

**Buying and reading.** The buyer pays with `register`, which takes the signed
terms, an ERC-3009 USDC authorization and a Semaphore identity commitment. The
buyer then calls `settle` with a Semaphore proof naming the reading address.
Anyone can submit either transaction. After that:

```ts
const plaintext = await openField({ handle: record.body, deposit, key: recordKey("a"), field: "body", signer, storage });
```

`openField` signs a request to the deposit's key server, unseals the record
key, fetches the ciphertext and decrypts it. A whole-repo buyer calls
`requestKey({ deposit, key: WHOLE_REPO, signer })` once, then uses
`deriveRecordKey` and `decryptField` for each record.

**Running a key server.** `serveAccess(body, { secret, chainId, registry, canRead })`
is the whole `POST /access` route. A Worker or HTTP server only parses the
body and maps `AccessError.status` (400 or 403) to the response.

**Trust model.** The key server can unseal any deposit made to it, so it could
decrypt the data. It is trusted not to do that, and not to release keys to
someone who hasn't paid. A publisher who doesn't want to trust it can run
their own key server and commit a deposit that names it. What the key server
doesn't see is plaintext in transit: it releases keys, and it never handles
the content.

---

## Contracts

### Base Sepolia (the default)

| Contract             | What it owns                                                                 |
| -------------------- | ---------------------------------------------------------------------------- |
| DataRegistry         | Every repo's head, and the update log                                        |
| SettlementRegistry   | Per-record prices the publisher signs, referral splits, and read access (USDC + Semaphore) |

`Fangorn.create` uses it when given no `config`, and the CLI when `CHAIN_NAME` is unset.

Its default RPC is `base-sepolia-rpc.publicnode.com`, not `sepolia.base.org`: the
official endpoint caps `eth_getLogs` at 200 blocks, too narrow to scan the registry's
history. Each config's `logWindow` is the most blocks one log query spans on its RPC
(Base 10,000, Arbitrum 100,000); `FANGORN_LOG_WINDOW` overrides it for a private RPC.

The CLI takes the chosen network's RPC and contracts from the environment when set:
`FANGORN_RPC_URL`, `FANGORN_DATA_REGISTRY` and
`FANGORN_SETTLEMENT_REGISTRY`, for a private
RPC or a local `anvil` with the contracts deployed.

`BaseSepoliaConfig` (also exported as `FangornConfig`, the default) in `src/config.ts`
holds the addresses the SDK uses. The sources are `fangorn-network/contracts`
(`solidity/script/Deployments.sol`); regenerate the ABIs with `pnpm abis`.

The two contracts don't call each other.

---

## Testing

### Unit Tests

```sh
pnpm test
```

### E2E Tests

The SDK suite (`src/test/sdk-suite.ts`) runs twice: in memory with the unit
tests, and against the contracts, built from source in a sibling checkout of
`fangorn-network/contracts` (`FANGORN_CONTRACTS_DIR` to point elsewhere) and
deployed to a fresh `anvil`. Nothing touches a real chain.

```sh
pnpm test:e2e
```

| File                           | Runs against                 | Needs                    |
| ------------------------------ | ---------------------------- | ------------------------ |
| `src/e2e/sdk.e2e.test.ts`      | the contracts on anvil       | `anvil`, `forge`         |
| `src/e2e/cards.e2e.test.ts`    | the contracts on anvil       | `anvil`, `forge`         |
| `src/e2e/paid.e2e.test.ts`     | the contracts on anvil       | `anvil`, `forge`         |
| `src/e2e/cli.e2e.test.ts`      | the CLI, on anvil            | `anvil`, `forge`         |
| `src/e2e/live.e2e.test.ts`     | Base Sepolia, read-only      | nothing                  |

Without `anvil`, `forge` or the contracts checkout the anvil suites are skipped
(in CI they fail). Storage is in memory; `E2E_STORAGE=pinata` runs the same suites
against Pinata (`PINATA_JWT`, `PINATA_GATEWAY`).

**The live suite** only reads: that the config's start block is the
DataRegistry's deployment.

---

## Limitations / Future Work

- Sealed fields are live (`self-hkdf-v1`, `field-v1`), but which fields to seal is expressed per-call at stage time — there is no schema-level `sealedFields` hint yet, and no CLI command for sealing.
- The SDK signs terms and relays `register`/`settle`, but carries no proving dependency: Semaphore identities and proofs are the buyer's.
- `field-v1` trusts the key server not to unseal deposits for itself. A TEE- or threshold-backed key server would ship as a new gadget, and the on-chain gadget registry (`gadget → resolver`) is still future work.
- Record schema validation is client-side only — no on-chain enforcement.

---

## License

MIT
