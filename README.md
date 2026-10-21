# Fangorn SDK

The Fangorn SDK is a decentralized "git for data" protocol. It follows an app <> publisher paradigm. An "app" is synonymous with gauranteed data availability and a 'view' of its underlying data. For publishers, it lets you cryptographically commit to to a version controlled "repo", which is data stored as a Merkle search tree in IPFS. Published data exists independently of an app, and apps emerge on top of data that they sponsor (pin).

A **repo** belongs to its publisher, keyed **`publisher : repo`**. Its state is a map of **records** (`{ id, type, payload }`, content-addressed), and its head is the digest of the latest commit block. Any wallet can update its own repos; updating a head is a compare-and-swap on the parent (i.e. a git ref update), and an update names no app.

An **app** is sponsored storage. Its owner accepts publishers; an accepted publisher uploads with the app's storage, and the app presents that publisher's repos at their latest heads.

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
CHAIN_NAME=arbitrumSepolia   # or baseSepolia
ACCESS_WORKER_URL=https://access-worker.your-subdomain.workers.dev   # optional (sealed fields)
SIGNED_URL_WORKER_URL=https://pinata-url-provider.your-subdomain.workers.dev   # optional
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

Publishing needs no app: any wallet updates its own repos, and an update names
no app. **An app is sponsored storage for the publishers it accepts**: its owner
accepts a publisher, the app pays for that publisher's uploads, and it includes
their repos at their latest heads, less what the owner withdraws
(`registry.exclude`).

```sh
fangorn set-app my-app     # persists the app; --app <name-or-id> overrides per command
fangorn app info           # owner, subscription, and where you stand in it
fangorn app claim          # claim it, if nobody owns it yet (irreversible; pays the subscription)
```

The protocol admin can ban a wallet network-wide: it can't claim an app or be
accepted into one, and no app stores or presents it.

**An app is a storage subscription** (ERC-5643; the app is a token that cannot
be transferred). `fangorn app claim` pays one period of the subscription fee in
USDC (the client approves exactly the fee for you), and `fangorn app renew` pays
the next once less than a period is left. An expired app stores and presents nothing
until it is renewed. **Apps provide storage**: you upload relative to
an app, and hosted uploads (`storage: { signedUrl: {} }`) are billed to the
client's app, which must have accepted you. There is no app-less hosted upload — with no
app, bring your own Pinata (`{ pinata }`) and pin your own data. A publisher that
pays for its own storage claims a one-member app.

**The owner accepts publishers.** `fangorn app accept <address>` is the whole
membership: no invitation, terms or join fee. The owner is their own first
publisher.

Owning an app comes with its own commands:

```sh
fangorn app accept <address>     # accept a publisher: the app stores and includes its data
fangorn app suspend <address>    # suspend a member from THIS app only
fangorn app reinstate <address>
fangorn app renew                # pay for the next period
fangorn app cancel               # end the subscription now, no refund
fangorn app withdraw-fees [to]   # join fees still owed from before joining was removed
```

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
fangorn commit records.json -m "initial import"

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

Each commit records its parent, so history is real and walkable. By default a commit is **additive** (the staged records join the repo's existing contents); pass `--replace` for snapshot semantics, where the file _is_ the repo's new state and anything omitted is removed — earlier history is retained either way. Blocks are content-addressed, so unchanged records are reused byte-for-byte across commits and never re-uploaded.

### Builders

Turning your source data into records is application logic, but the SDK ships a small **harness** for the common "a directory of files → records" case, exported from the package root:

```ts
import { buildAssetGraph, extractMarkdownLinks } from "@fangorn-network/sdk";

// One processor per file extension. Return the vertex tag/payload and the
// ids this file links to; buildAssetGraph wires the edges (rel: "links"),
// dropping self-links and links to files that don't exist.
const { vertices } = buildAssetGraph("./docs", {
	processors: {
		".md": (file) => ({
			tag: "note",
			payload: { title: file.nameNoExt, body: file.readText() },
			links: extractMarkdownLinks(file.readText()), // markdown links + [[wikilinks]]
		}),
	},
});

await fangorn.commit({
	repo: "rusty-anchor",
	message: "import docs",
	records: vertices.map((v) => ({ id: v.id, type: v.tag, payload: v.payload })),
});
```

Each `id` is the filename without extension. The harness also returns the links between files as `edges`; records have no edges, so keep links you need in the payload. For anything that isn't "files in a folder," build the records yourself and pass them straight to `commit` / `uploadBatch` — the harness is a convenience, not a requirement.

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
previous one. Under an app, only what the app presents is emitted. Each push's
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
	config: FangornConfig, // defaults to Arbitrum Sepolia
	appId: "my-app", // optional for reads (no app: each publisher's latest head); hosted uploads need one
});

// The app stores and presents your repos once its owner accepts this wallet
// (`apps.acceptPublisher`). A non-member's update still lands; the app just
// presents nothing of it.
const apps = fangorn.getAppRegistry();
await apps.canPublish(fangorn.getAddress());
```

The storage paywall lives on the same client, because an app is its
subscription: `apps.subscriptionFee()`, `apps.expiresAt()`,
`apps.renewSubscription()`, `apps.cancelSubscription()`, and
`apps.access(publisher)` — the `{ canPublish, owner, expiresAt }` the upload gate
reads. The contract enforces the expiry itself: `canPublish` is false once it
has passed.

`fangorn.getMembershipRegistry()` (consumer access to an app's paid records)
hangs off the same object. It takes the app id per call, so `setAppId`
deliberately leaves it alone.

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
	message: "initial import",
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
	message: "add a track, drop the artist",
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
	console.log(c.cid, c.message);
}

// What a commit changed vs. its parent ({ puts, deletes })
const diff = await fangorn.show(tip!);

// Every record currently in one of your repos
const { records } = await fangorn.inspectRepo("rusty-anchor"); // { id, cid, type, payload }[]

// Someone else's repo, as this client's app presents it
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

### Subscribe to a whole app

Every update lands under `publisher:repo`, and each pair is its own on-chain
timeline. Two publishers — or one publisher's two repos — never contend for the
same compare-and-swap.

`subscribeApp` yields the same `RepoChange` values as `subscribe`, from every
publisher the app presents, less its exclusions. With no app it is every update
by anyone:

```ts
// Everything the app presents
for await (const change of fangorn.subscribeApp({
	signal: controller.signal,
})) {
	console.log(change.owner, change.repo, change.puts.length);
}

// Narrow it: every publisher's "reviews" repo, or one publisher's whole footprint
fangorn.subscribeApp({ repo: "reviews" });
fangorn.subscribeApp({ owner: "0x..." });
```

The app is per-client state, not part of the network config — set it when you
create the client, or switch at runtime:

```ts
const fangorn = Fangorn.create({ privateKey, storage, appId: "my-app" });
fangorn.setAppId("my-other-app"); // by name, or by 32-byte app id
fangorn.getAppId(); // 0x… — what the registry keys on
```

Under an app, reads (`readRepo`, `appRepos`, `subscribe`) are what the app
presents: its members' latest heads (`canPublish`), less its exclusions. With
no app they are each publisher's latest heads.

Apps live in the AppRegistry, and membership of one is what gets your storage
paid for and your repos presented:

```ts
const apps = fangorn.getAppRegistry();

await apps.registerApp(); // claim it — pays the subscription fee (USDC); you are its first publisher
await apps.acceptPublisher(publisher); // owner: accept a publisher
await apps.setPublisherSuspended(publisher, true); // owner: suspend them from this app
await apps.renewSubscription(); // owner: pay for the next period
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
`/access` endpoint yourself, and `MembershipRegistryClient` (`canRead`, `planOf`)
reads the membership rail directly.

**Trust model.** For `worker-usdc-v1` the access worker is the "somewhat trusted" party:
it holds the unsealing key and sees plaintext at release time. That is deliberate for
v1 — no TEE, no threshold network. Swapping in a stronger backend later is a _new
gadget_ behind the same handle shape, so committed data doesn't change form.
`self-hkdf-v1` trusts nobody: the worker is dumb storage and never holds a key.

---

## Contracts

### Arbitrum Sepolia

| Contract             | Address                                      | What it owns                                        |
| -------------------- | -------------------------------------------- | --------------------------------------------------- |
| DataRegistry         | `0x72B5f83526F3893aF9f1eE0f32A27218EA09f8aE` | Every repo's head, and the update log           |
| AppRegistry          | `0x55e6209ea1833ceD900989a3b3b22466934E04A5` | Apps: owner, accepted publishers, bans, storage subscription (ERC-5643, USDC); what each app excludes |
| MembershipRegistry   | `0xDF17030Cd65435C86eb043F31DDACa99E819E347` | Time-limited, unlinkable access to an app's paid records (USDC + Semaphore) |

### Base Sepolia

| Contract             | Address                                      |
| -------------------- | -------------------------------------------- |
| DataRegistry         | `0xE9183f768865dd2Cde5f1B71F8446F0Cd798ebe0` |
| AppRegistry          | `0x0D3e98399df41b558048Cdd7D71723c37A3A9D6F` |
| MembershipRegistry   | `0x0e96C012b5c53622EcDAA82F342E31C2623A04f5` |

Use it from the SDK with `Fangorn.create({ config: BaseSepoliaConfig, ... })`, or
from the CLI with `CHAIN_NAME=baseSepolia` (or pick it in `fangorn init`).

Its default RPC is `base-sepolia-rpc.publicnode.com`, not `sepolia.base.org`: the
official endpoint caps `eth_getLogs` at 200 blocks, too narrow to scan the registry's
history. Each config's `logWindow` is the most blocks one log query spans on its RPC
(Base 10,000, Arbitrum 100,000); `FANGORN_LOG_WINDOW` overrides it for a private RPC.

`FangornConfig` (Arbitrum Sepolia) and `BaseSepoliaConfig` in `src/config.ts` are the authoritative list and what the SDK
uses by default — prefer it over any address copied out of a document,
including this table. The sources are `fangorn-network/contracts`
(`solidity/script/Deployments.sol`); regenerate the ABIs with `pnpm abis`.

Neither contract calls the other: an update names no app, and an app presents
its members (`canPublish`).

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
| `src/e2e/live.e2e.test.ts`     | Arbitrum Sepolia, read-only  | nothing                  |

Without `anvil`, `forge` or the contracts checkout the anvil suites are skipped
(in CI they fail). The deployer is the protocol admin, so the admin suite needs
no real key. Storage is in memory; `E2E_STORAGE=pinata` runs the same suites
against Pinata (`PINATA_JWT`, `PINATA_GATEWAY`).

**The live suite** only reads: that the registries point at each other, and that
the config's start block is the AppRegistry's deployment.

---

## Limitations / Future Work

- Sealed fields are live (`self-hkdf-v1`, `worker-usdc-v1`), but which fields to seal is expressed per-call at stage time — there is no schema-level `sealedFields` hint yet, and no CLI command for sealing.
- The SDK covers the **app owner** half of the membership rail (`setPlan`, plus the reads and the relayed `join`/`claim`). The **buyer** half — Semaphore identity, the ERC-3009 authorization, membership proofs — lives in [`@fangorn-network/fetch`](https://github.com/fangorn-network/x402f), which relays both writes through a facilitator so the buyer needs no gas. This package deliberately carries no proving dependency.
- `fangorn subscribe` is the event stream, not the storage paywall — that is `fangorn app claim` / `fangorn app renew`.
- `worker-usdc-v1` trusts the access worker with the unsealing key. A TEE- or threshold-backed replacement would ship as a new gadget, and the on-chain gadget registry (`gadget → resolver`) is still future work.
- Record schema validation is client-side only — no on-chain enforcement.
- An app presents each accepted publisher's latest head; the data itself is unverified, so accept publishers you trust.

---

## License

MIT
