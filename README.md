# Fangorn SDK

The Fangorn SDK is a decentralized "git for data" protocol. Publishers cryptographically commit to version-controlled "repos": data stored as a Merkle search tree in IPFS, with each repo's head on chain. Published data belongs to its publisher, and needs no app.

A **repo** belongs to its publisher, keyed **`publisher : repo`**. Its state is a map of **records** (`{ id, type, payload }`, content-addressed), and its head is the digest of the latest commit block. Any wallet can update its own repos; updating a head is a compare-and-swap on the parent (i.e. a git ref update), and an update names no app.

An **app** is a curator's repo of citations: records that point at other publishers' records at named heads. The AppRegistry names it, and says where its referral share is paid. An app selects and arranges data; it never holds or admits it.

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
fangorn wallet show            # address, public key, balance, network, current app
fangorn wallet show --reveal   # also prints the PRIVATE key — it grants full control
```

The private key is never printed without `--reveal`: terminal scrollback, shell
logs and screen shares all outlive the command.

### Pick an app

Publishing and reading need no app. An app is a name for a curator's repo of
citations, with a payout address for referrals and an optional agent card.

```sh
fangorn set-app my-app                 # the app this CLI manages; --app <name-or-id> overrides per command
fangorn app info                       # owner, repo, payout address, agent card
fangorn app claim                      # register it, if nobody has (free)
fangorn app curator picks              # point it at your repo "picks" (--curator <address> for another's)
fangorn app payout <address>           # where referral shares go (default: the owner)
fangorn app agent --access-worker <url>   # register the worker's agent card with ERC-8004 (or pass a card URL)
fangorn app rename <name>              # give the app a new name; the old ones keep working
```

**Renaming moves nothing.** `fangorn app rename` (SDK: `fangorn.renameApp(name)`)
makes the new name's id an alias of the id the app was registered under, its
*canonical* id. Every name the app has gone by still resolves to it and stays the
owner's. The listings and the contract's events keep the canonical id;
`getAppRegistry().canonicalAppId()` and `.currentAppId()` translate between them,
and `fangorn app info` shows both when they differ. The CLI saves the new name to
its config file, unless the app came from `--app` or `FANGORN_APP_ID`, which you
update yourself.

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

`fangorn subscribe --all` watches the whole app instead (every presented publisher and repo); a repo name or `--owner` narrows it.

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
	appId: "my-app", // optional: the app this client manages
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

### Apps

An app is a curator's repo of citations, named in the AppRegistry:

```ts
const fangorn = Fangorn.create({ privateKey, storage, appId: "my-app" });
const apps = fangorn.getAppRegistry();

await apps.registerApp(); // free; first come, first served
await apps.setCurator(fangorn.getAddress(), "picks"); // the app's repo of citations
await apps.setPayout(payoutAddress); // where referral shares go
await apps.curatorOf(); // { curator, repo }
fangorn.setAppId("my-other-app"); // by name, or by 32-byte app id
```

See the [CLI quickstart](#pick-an-app) for the same flow from the
command line.

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

| Gadget           | Key derivation                                | Who can open it                                                                     |
| ---------------- | --------------------------------------------- | ----------------------------------------------------------------------------------- |
| `self-hkdf-v1`   | HKDF from your own 32-byte secret             | Only you. No ECDH, no recipient, no gate — nobody else can re-derive the key.       |
| `worker-usdc-v1` | X25519 ECDH to the access worker's static key | Anyone who has settled for the resource; the worker checks the Settlement Registry. |

Every key is bound to a 32-byte **`resourceId`**, which doubles as the Settlement
Registry key. The same secret cannot cross-open a different resource, and changing
_who can read_ means re-sealing under a new gadget/`resourceId` and committing a
record that points at the new bytes.

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

### `worker-usdc-v1` — settlement-gated

For paid or conditionally-readable data, seal to the **access worker's** static X25519
public key and hand the ciphertext to the worker, which stores the opaque bytes in R2
(never IPFS — a large, frequently-fetched ciphertext shouldn't burn public gateway
egress). `encryptAndUpload` does both and returns a **handle**:

```ts
import { encryptAndUpload, GADGET_WORKER_USDC_V1 } from "@fangorn-network/sdk";

const handle = await encryptAndUpload({
	gadget: GADGET_WORKER_USDC_V1,
	plaintext: new TextEncoder().encode("the full dataset"),
	resourceId,
	workerPubkey, // the access worker's static X25519 key (32 bytes)
	storage: {
		workerUrl: process.env.ACCESS_WORKER_URL!,
		authToken: process.env.ACCESS_WORKER_TOKEN!,
		contentType: "application/octet-stream",
	},
});
```

The handle is what you commit in place of the plaintext value — the engine treats it
as an ordinary opaque object in the record payload:

```jsonc
{
	"@type": "handle",
	"objectKey": "…", // R2 object key
	"workerUrl": "https://access-worker.example.workers.dev",
	"encryption": {
		"gadget": "worker-usdc-v1",
		"resourceId": "0x…", // Settlement Registry key + HKDF binding
		"ciphertextHash": "0x…", // sha256 of the sealed bytes
		"workerPubkey": "0x…", // worker-usdc-v1 only
	},
}
```

### Reading a handle

Both gadgets resolve through the worker's `POST /access`. `decryptHandle` signs the
request (the worker recovers the signer's address and checks the Settlement Registry
for `resourceId`), fetches the bytes, and returns plaintext:

```ts
import { decryptHandle } from "@fangorn-network/sdk";

const plaintext = await decryptHandle({
	handle,
	signer, // any viem LocalAccount / WalletClient — the address settlement is checked for
	nullifier, // per-read nullifier (replay / anonymity)
	// ownSecret,           // self-hkdf-v1 only
});
```

- **`self-hkdf-v1`** — the resource is priced 0, so any signed request passes; the bytes
  come back _still sealed_, are checked against `ciphertextHash`, and are unsealed
  locally with `ownSecret`.
- **`worker-usdc-v1`** — the worker streams bytes only once the signer has settled,
  having unsealed with its own key; the bytes arrive as plaintext.

`buildAccessRequest` / `accessMessageHash` are exported if you want to drive the
`/access` endpoint yourself, and `getSettlementRegistry()` (`canRead`, `signTerms`,
`register`, `settle`) reads and writes the payment contract directly.

**Trust model.** For `worker-usdc-v1` the access worker is the "somewhat trusted" party:
it holds the unsealing key and sees plaintext at release time. That is deliberate for
v1 — no TEE, no threshold network. Swapping in a stronger backend later is a _new
gadget_ behind the same handle shape, so committed data doesn't change form.
`self-hkdf-v1` trusts nobody: the worker is dumb storage and never holds a key.

---

## Contracts

### Base Sepolia (the default)

| Contract             | What it owns                                                                 |
| -------------------- | ---------------------------------------------------------------------------- |
| DataRegistry         | Every repo's head, and the update log                                        |
| SettlementRegistry   | Per-record prices the publisher signs, referral splits, and read access (USDC + Semaphore) |
| AppRegistry          | App names: owner, repo of citations, payout address, agent card              |

`Fangorn.create` uses it when given no `config`, and the CLI when `CHAIN_NAME` is unset.

Its default RPC is `base-sepolia-rpc.publicnode.com`, not `sepolia.base.org`: the
official endpoint caps `eth_getLogs` at 200 blocks, too narrow to scan the registry's
history. Each config's `logWindow` is the most blocks one log query spans on its RPC
(Base 10,000, Arbitrum 100,000); `FANGORN_LOG_WINDOW` overrides it for a private RPC.

The CLI takes the chosen network's RPC and contracts from the environment when set:
`FANGORN_RPC_URL`, `FANGORN_APP_REGISTRY`, `FANGORN_DATA_REGISTRY` and
`FANGORN_SETTLEMENT_REGISTRY`, for a private
RPC or a local `anvil` with the contracts deployed.

`BaseSepoliaConfig` (also exported as `FangornConfig`, the default) in `src/config.ts`
holds the addresses the SDK uses. The sources are `fangorn-network/contracts`
(`solidity/script/Deployments.sol`); regenerate the ABIs with `pnpm abis`.

No contract calls another, and an update names no app.

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
| `src/e2e/apps.e2e.test.ts`     | the contracts on anvil       | `anvil`, `forge`         |
| `src/e2e/admin.e2e.test.ts`    | the contracts on anvil       | `anvil`, `forge`         |
| `src/e2e/cli.e2e.test.ts`      | the CLI, on anvil            | `anvil`, `forge`         |
| `src/e2e/live.e2e.test.ts`     | Base Sepolia, read-only      | nothing                  |

Without `anvil`, `forge` or the contracts checkout the anvil suites are skipped
(in CI they fail). The deployer is the protocol admin, so the admin suite needs
no real key. Storage is in memory; `E2E_STORAGE=pinata` runs the same suites
against Pinata (`PINATA_JWT`, `PINATA_GATEWAY`).

**The live suite** only reads: that the registries point at each other, and that
the config's start block is the AppRegistry's deployment.

---

## Limitations / Future Work

- Sealed fields are live (`self-hkdf-v1`, `worker-usdc-v1`), but which fields to seal is expressed per-call at stage time — there is no schema-level `sealedFields` hint yet, and no CLI command for sealing.
- The SDK signs terms and relays `register`/`settle`, but carries no proving dependency: Semaphore identities and proofs are the buyer's.
- `worker-usdc-v1` trusts the access worker with the unsealing key. A TEE- or threshold-backed replacement would ship as a new gadget, and the on-chain gadget registry (`gadget → resolver`) is still future work.
- Record schema validation is client-side only — no on-chain enforcement.

---

## License

MIT
