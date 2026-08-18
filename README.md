# Fangorn SDK

The Fangorn SDK is git for graphs, enabling version control and distribution of *metagraphs* organized into applications and namespaces. 

It lets you treat IPFS as a hierarchical data store for your app-level storage with enforced terms, conditions, and validation logic for publishers.  Data is published under a *namespace* in a *registered application*, **`app : publisher : namespace`**. Each namespace has its own on-chain state root (the digest of a commit block wrapping a native IPLD DAG) owned by the *publisher* who passed the app's validation logic. Updating a namespace root is a compare-and-swap operation (i.e. a git ref update).

Each namespace's state is represented by a **metagraph**, $G = (V, E, L)$ where $V$=**vertices** (a JSON payload tagged by a free-form schema id) and $E$=**edges** (a labeled relation between two vertices, as native IPLD links), $L$=**labels** (the allowed labels in any edge).

**Version Control**

Datasets are versioned like git. Each update is a **commit** that points at its parent (previous graph state) and at a single **CAR file** (a packfile) holding only the blocks that were introduced in the commit. The onchain data registry stores the root of the latest commit, with full history living in IPFS. Full history is reconstructible from the onchain root (head) of a namespace without an indexer required. 

- `commit` (local) builds the graph in memory and persists it in two uploads, one CAR (the graph data) + one small commit block.
- `push` (remote) updates the onchain root to the latest staged commit

> Since the metagraph edges are native IPLD links, the DAG (directed acyclic graph) is easily 'diffable' and verifiable from the root stored onchain, though it is not easily queryable (see: [quickbeam](https://github.com/fangorn-network/quickbeam))

**Storage**

Metagraphs are stored in IPFS. The SDK currently expects Pinata to be used to ensure data availability, which will be relaxed in the future.

#### What it is not

This is not a graph database, there is no query langauge here, and there is no native indexer.


## Supported Networks

- Arbitrum Sepolia

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
CHAIN_NAME=arbitrumSepolia
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

### Pick an app, then register

Publishing takes standing in **two** registries, and skipping the second is the
usual first failure: `commitStateRoot` cross-calls `isRegisteredForApp`, so a
wallet registered globally but not joined to the app gets `NotRegisteredForApp`
at push time — far from the cause.

```sh
fangorn set-app my-app     # persists the app; --app <name-or-id> overrides per command
fangorn app info           # owner, terms, join fee, and where you stand in both registries
fangorn app claim          # claim it, if nobody owns it yet (irreversible)
fangorn register           # global standing in the DataRegistry, then join the app
```

`fangorn register` is idempotent and does both halves, reporting each. It is the
only registration command you normally need; `fangorn app join` exists for
joining an app you don't own, and for re-accepting terms after the owner moves
them (free).

Owning an app comes with its own commands:

```sh
fangorn app terms <hash> [uri]   # publish new terms — everyone must re-accept
fangorn app fee <wei>            # what joining costs
fangorn app suspend <address>    # eject a publisher from THIS app only
fangorn app reinstate <address>
```

### Track a namespace (git-native repo)

A **namespace** is an entry in your on-chain root map. `repo init` allocates it and starts tracking it in a local `.fangorn/` pointer file (just a HEAD ref — there is no local object store; commit objects and their CARs live in IPFS).

```sh
# Allocate a namespace on-chain (no-op if it already exists) and track it here
fangorn repo init rusty-anchor
```

### Commit → push

`commit` snapshots a namespace's vertices/edges into a new commit (one CAR upload to IPFS, advances your local HEAD) — it does **not** touch the chain. `push` fast-forwards the on-chain state root to your local tip: the single permissioned step.

```sh
# Snapshot graph data into a new local commit — does NOT push
fangorn commit graph.json -m "initial import"

# Settle the local tip on-chain (permission + fast-forward checked here)
fangorn push
fangorn push --force        # push even if it doesn't fast-forward the on-chain tip
```

`graph.json` is a JSON file of vertices and (optionally) the edges between them. Edges reference vertices by their local `id`:

```json
{
	"vertices": [
		{
			"id": "t1",
			"tag": "track",
			"payload": { "title": "Locura", "artist": "Alice" }
		},
		{ "id": "a1", "tag": "artist", "payload": { "name": "Alice" } }
	],
	"edges": [{ "rel": "performed_by", "from": "t1", "to": "a1" }]
}
```

Each commit records its parent, so history is real and walkable. By default a commit is **additive** (the staged graph joins the namespace's existing contents); pass `--replace` for snapshot semantics, where the file _is_ the namespace's new state and anything omitted is removed — earlier history is retained either way. Blocks are content-addressed, so unchanged data is reused byte-for-byte across commits and never re-uploaded.

### Graph Builders

Turning your source data into vertices and edges is application logic, but the SDK ships a small **harness** for the common "a directory of files → a graph" case, exported from the package root:

```ts
import { buildAssetGraph, extractMarkdownLinks } from "@fangorn-network/sdk";

// One processor per file extension. Return the vertex tag/payload and the
// ids this file links to; buildAssetGraph wires the edges (rel: "links"),
// dropping self-links and links to files that don't exist.
const { vertices, edges } = buildAssetGraph("./docs", {
	processors: {
		".md": (file) => ({
			tag: "note",
			payload: { title: file.nameNoExt, body: file.readText() },
			links: extractMarkdownLinks(file.readText()), // markdown links + [[wikilinks]]
		}),
	},
});

await fangorn.commit({
	namespace: "rusty-anchor",
	message: "import docs",
	vertices,
	edges,
});
```

Each vertex `id` is the filename without extension. For anything that isn't "files in a folder," build the `{ vertices, edges }` arrays yourself and pass them straight to `commit` / `uploadBatch` — the harness is a convenience, not a requirement.

### Inspect

```sh
fangorn status              # local tip vs on-chain tip
fangorn log                 # walk commit history from the tip (newest first)
fangorn log -n 5            # limit
fangorn show                # the tip commit + what it changed vs its parent
fangorn show <commitCid>    # a specific commit

# List every vertex and edge committed under a namespace, as JSON
fangorn read                          # defaults to the current repo's namespace + owner
fangorn read rusty-anchor --owner 0x... --pretty
```

### Clone

Reconstruct tracking of a published namespace from its on-chain tip alone. History and contents are then fetched on demand from IPFS.

```sh
fangorn clone <owner> rusty-anchor
fangorn clone <owner> rusty-anchor --dir ./somewhere
```

### Subscribe (light client)

Watch a namespace for on-chain updates and stream the diffs — **no subgraph, no
indexer**. Each `app:publisher:namespace` triple is its own timeline, and the
registry indexes all three parts, so this watches exactly that timeline's
`StateCommitted` event (read straight from the RPC node) and, for each new root,
diffs the namespace's link sets against the previous root.
Only pushes that actually changed the namespace are emitted. Each push's
blocks arrive as one CAR download, resolved from IPFS on demand.

```sh
# Watch the current repo's namespace; each change is one JSON line on stdout.
fangorn subscribe

# Watch any publisher's namespace explicitly.
fangorn subscribe rusty-anchor --owner 0x...

# Feed an embeddings/index builder directly.
fangorn subscribe rusty-anchor --owner 0x... | my-index-builder
```

Each emitted line is a namespace change:

```jsonc
{
	"namespace": "rusty-anchor",
	"owner": "0x...",
	"commitCid": "bafy...", // the new on-chain tip
	"blockNumber": "12345678", // persist this to resume
	"addedVertices": [
		{ "cid": "bafy...", "schemaId": "track", "payload": { "title": "Locura" } },
	],
	"addedEdges": [
		{ "sourceCid": "bafy...", "relation": "by", "targetCid": "bafy..." },
	],
	"removedVertexCids": ["bafy..."],
	"removedEdges": [],
}
```

**Resumability.** The last processed block is saved to
`.fangorn/subscribe-<owner>-<namespace>.json` after each change, so restarting
replays only what you missed (via `eth_getLogs`) before going live. Override or
reset:

```sh
fangorn subscribe --from-block 12000000   # replay from a specific block
fangorn subscribe --from-start            # replay the namespace's full history
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
	appId: "my-app", // defaults to "fangorn"
	domain: "localhost",
});

// Register once before committing — BOTH registries. The second is the one
// `commitStateRoot` cross-calls, so skipping it surfaces as a revert at push
// time rather than here.
const self = fangorn.getAddress();
const data = fangorn.getDataRegistry();
const apps = fangorn.getAppRegistry();

if (!(await data.isRegistered(self))) await data.register();
if (!(await apps.isRegisteredForApp(self))) await apps.registerForApp();
```

`joinInfo` is what a join screen needs, and it separates two failures a bare
"not registered" conflates — never joined, versus joined before the owner moved
the terms:

```ts
import { needsReacceptance } from "@fangorn-network/sdk";

const info = await apps.joinInfo(self);
if (needsReacceptance(info)) await apps.registerForApp(); // free re-accept
```

The other two clients hang off the same object: `fangorn.getSubscriptionRegistry()`
(publisher storage paywall) and `fangorn.getSettlementRegistry()` (consumer
pay-then-read). Neither is app-scoped — a subscription is per wallet and a
resource is per owner — so `setAppId` deliberately leaves both alone.

### Namespaces & the git-native flow

`initRepo` allocates a namespace on-chain (idempotent). Then split building from settling:
`commit` writes a commit object locally (durable in IPFS, HEAD not yet on-chain), and
`push` fast-forwards the on-chain root to it.

```ts
// Allocate the namespace (no-op if it already exists)
await fangorn.initRepo("rusty-anchor");

// First commit — no parent
const c1 = await fangorn.commit({
	namespace: "rusty-anchor",
	message: "initial import",
	vertices: [
		{ id: "t1", tag: "track", payload: { title: "Locura", artist: "Alice" } },
		{ id: "a1", tag: "artist", payload: { name: "Alice" } },
	],
	edges: [{ rel: "performed_by", from: "t1", to: "a1" }],
});

// Settle it on-chain (fast-forward from "no tip yet")
await fangorn.push("rusty-anchor", c1.commitCid);

// A follow-up commit builds on the previous one
const c2 = await fangorn.commit({
	namespace: "rusty-anchor",
	parent: c1.commitCid,
	message: "add another track",
	vertices: [
		{ id: "t2", tag: "track", payload: { title: "Otra", artist: "Alice" } },
	],
});
await fangorn.push("rusty-anchor", c2.commitCid); // refuses unless it fast-forwards the on-chain tip (pass { force: true } to override)
```

### History, diff & read

Walk history from the on-chain tip (IPFS only, no indexer), and read the current namespace contents:

```ts
const tip = await fangorn.onChainTip(fangorn.getAddress(), "rusty-anchor");

// Walk commits, newest first
for await (const c of fangorn.log(tip!)) {
	console.log(c.cid, c.message);
}

// What a commit changed vs. its first parent (namespaced vertex/edge entries added/removed)
const diff = await fangorn.show(tip!);

// Every vertex and edge currently committed under a namespace
const contents = await fangorn.inspectNamespace("rusty-anchor");
// contents.vertices: { cid, schemaId, payload }[]   contents.edges: { sourceCid, relation, targetCid }[]
```

> The fast-forward check in `push` is enforced client-side against the on-chain
> head in this release; on-chain write-authorization lands in a later slice.

### Immediate-write helpers

For the common "stage and settle in one shot" case, `upload` (one vertex) and `uploadBatch`
(many vertices + edges) run the whole commit-and-push atomically:

```ts
await fangorn.upload("rusty-anchor", { title: "Locura" }, "track");

await fangorn.uploadBatch(
	"rusty-anchor",
	[{ id: "t1", tag: "track", payload: { title: "Locura" } }],
	[
		/* edges */
	],
);
```

### Subscribe (light client)

`subscribe` is an async generator over namespace-scoped changes. It optionally
replays from a block cursor (`fromBlock`) and then watches live until the
`AbortSignal` fires. Each change carries `blockNumber` — persist it to resume.

```ts
const controller = new AbortController();

for await (const change of fangorn.subscribe({
	namespace: "rusty-anchor",
	owner: "0x...", // defaults to your own address
	fromBlock: savedCursor, // omit to start live from the current tip
	signal: controller.signal,
})) {
	for (const v of change.addedVertices) index.upsert(v.cid, v.payload);
	for (const cid of change.removedVertexCids) index.remove(cid);
	persistCursor(change.blockNumber);
}
```

The pure diff primitive is also exposed on the engine —
`engine.namespaceDiff(oldRootHex, newRootHex, namespace)` — if you want to diff
two arbitrary roots without watching.

### Subscribe to a whole app

Namespaces are hierarchical: every commit lands under `app:publisher:namespace`,
and each triple is its own on-chain timeline. Two publishers — or one publisher's
two namespaces — never contend for the same compare-and-swap.

The registry indexes all three parts, so an app-wide feed is one topic filter
rather than a per-publisher fan-out. `subscribeApp` yields the same
`NamespaceChange` values as `subscribe`, from every publisher in the app:

```ts
// Everything published under this app, by anyone
for await (const change of fangorn.subscribeApp({
	signal: controller.signal,
})) {
	console.log(change.owner, change.namespace, change.addedVertices.length);
}

// Narrow it: every publisher's "reviews" namespace, or one publisher's whole app footprint
fangorn.subscribeApp({ namespace: "reviews" });
fangorn.subscribeApp({ owner: "0x..." });
```

The app is per-client state, not part of the network config — set it when you
create the client, or switch at runtime:

```ts
const fangorn = Fangorn.create({ privateKey, storage, appId: "my-app" });
fangorn.setAppId("my-other-app"); // by name, or by 32-byte app id
fangorn.getAppId(); // 0x… — what the registry keys on
```

`setAppId` re-scopes the DataRegistry and AppRegistry clients **together**. They
must never disagree: a DataRegistry pointed at one app while the AppRegistry
answers for another checks membership against the wrong market, and it surfaces
as a revert at commit time, far from the mistake.

Apps live in the AppRegistry, and membership of one is a precondition for
publishing under it:

```ts
const apps = fangorn.getAppRegistry();

await apps.registerApp(termsHash, termsUri, joinFee); // claim it (first come, first served)
await apps.registerForApp(); // join it, accepting the current terms
```

Joining reads the terms hash immediately before sending and passes it as an
argument, so the contract reverts `TermsMismatch` if the owner moved the terms
in between. A race is a revert, never silent agreement to a document the
publisher never saw. The join fee is read from the chain for the same reason a
caller never supplies it: a caller can supply the wrong one.

See the [CLI quickstart](#pick-an-app-then-register) for the same flow from the
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
only an opaque reference to it, keeping the graph — its shape, its edges, its
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
vertex that points at the new bytes.

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

// later, after `read` / `inspectNamespace` hands the payload back:
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
as an ordinary opaque object in the vertex payload:

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
`/access` endpoint yourself, and `SettlementRegistryClient` (`isSettled`, `getPrice`)
reads the settlement rail directly.

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
| DataRegistry         | `0x3b0cf19bef492500401e4d74e6fa29a56d0cc67b` | Namespace state roots; global publisher standing    |
| AppRegistry          | `0xcc92f3d827df33be7323eef28e67a509034f5a59` | Apps: owner, terms, join fee, per-app membership    |
| SubscriptionRegistry | `0xe82192be4c20d3dc93fbc63e3ecd7e13c3889726` | Publisher-side storage paywall (USDC)               |
| SettlementRegistry   | `0x47a2a0d7e7fc8a044f6d6f1d878c4178952ea779` | Consumer-side pay-then-read rail (USDC + Semaphore) |

`FangornConfig` in `src/config.ts` is the authoritative list and what the SDK
uses by default — these contracts have been redeployed more than once, so prefer
the config over any address copied out of a document, including this table.

The dependency runs one way: `DataRegistry.commitStateRoot` cross-calls
`AppRegistry.isRegisteredForApp`, and `SubscriptionRegistry` cross-calls
`DataRegistry.isRegistered`. Nothing calls back the other way.

---

## Testing

### Unit Tests

```sh
pnpm test
```

### E2E Tests

Runs the storage + on-chain anchor flow against live IPFS + the deployed contract.

```sh
cp env.example .env
pnpm test:e2e
```

Required variables:

| Variable          | Description                               |
| ----------------- | ----------------------------------------- |
| `ETH_PRIVATE_KEY` | Publisher private key (needs testnet ETH) |
| `PINATA_JWT`      | Pinata API JWT                            |
| `PINATA_GATEWAY`  | Pinata gateway URL                        |

The publisher must be registered on the target key — `fangorn register` does
both halves (DataRegistry standing, then joining the app). The suite's own
`TestBed.registerApp` / `TestBed.register` do the same thing programmatically,
claiming the app first if nobody owns it.

---

## Limitations / Future Work

- Sealed fields are live (`self-hkdf-v1`, `worker-usdc-v1`), but which fields to seal is expressed per-call at stage time — there is no schema-level `sealedFields` hint yet, and no CLI command for sealing.
- The SDK covers the **publisher** half of the settlement rail (`createResource`, `updatePrice`, `setDisabled`, plus the reads). The **buyer** half — Semaphore identity, the EIP-3009 authorization, membership proofs — lives in [`@fangorn-network/fetch`](https://github.com/fangorn-network/x402f), which relays both writes through a facilitator so the buyer needs no gas. This package deliberately carries no proving dependency.
- The SubscriptionRegistry (publisher storage paywall) has a client but no CLI command yet; `fangorn subscribe` is the event stream, not the paywall.
- `worker-usdc-v1` trusts the access worker with the unsealing key. A TEE- or threshold-backed replacement would ship as a new gadget, and the on-chain gadget registry (`gadget → resolver`) is still future work.
- Vertex/edge schema validation is client-side only — no on-chain enforcement.
- Push authorization is client-side in this release; on-chain write policies and non-fast-forward rejection are planned.
- Reads target one publisher's namespace at a time; cross-publisher discovery is a higher layer.

---

## License

MIT
