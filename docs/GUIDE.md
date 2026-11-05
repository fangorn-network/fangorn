# Fangorn Guide

This guide covers everything after the [README](../README.md): configuration, the commit and push flow, reading and subscribing, agent cards, storage, and sealed and paid fields.

- [Configure](#configure)
- [Publish: commit → push](#publish-commit--push)
- [Read, history, clone](#read-history-clone)
- [Subscribe](#subscribe)
- [Agent cards](#agent-cards)
- [Storage](#storage)
- [Sealed and paid fields](#sealed-and-paid-fields)
- [Network config](#network-config)
- [Limitations](#limitations)

---

## Configure

### SDK

`Fangorn.create` is synchronous. Pass it either a `privateKey` or your own viem `walletClient`, plus storage (see [Storage](#storage)).

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

### CLI

`fangorn init` prompts for the following values and writes them to `~/.fangorn/config.json`:

- the wallet private key
- a Pinata JWT. Leave it blank to use hosted signed-URL uploads, a testnet convenience: files may be unpinned without notice.
- a Pinata gateway. Leave it blank to use the network's gateway.
- a presigned-URL worker. Leave it blank to use the network's hosted worker.

Environment variables take precedence over the config file:

```sh
ETH_PRIVATE_KEY=0x...
PINATA_JWT=...
PINATA_GATEWAY=https://your-gateway.mypinata.cloud
SIGNED_URL_WORKER_URL=...       # optional
FANGORN_RPC_URL=...             # optional overrides, e.g. for a local anvil
FANGORN_DATA_REGISTRY=0x...
FANGORN_SETTLEMENT_REGISTRY=0x...
FANGORN_LOG_WINDOW=...          # max blocks per eth_getLogs on your RPC
```

```sh
fangorn wallet show             # address, public key, balance, network
fangorn wallet show --reveal    # also prints the private key
```

---

## Publish: commit → push

There are two steps, as in git:

- **`commit`** builds the new state and uploads it to IPFS: one CAR file holding the new blocks, plus one small commit block. It does not touch the chain.
- **`push`** moves the on-chain head to that commit. The registry accepts the push only if the commit's parent is the current head (a compare-and-swap).

Blocks are content-addressed, so a record that hasn't changed is reused across commits and never uploaded again.

### CLI

`fangorn repo init` creates the repo with an empty first commit, pushes it, and starts tracking it in `./.fangorn/`. That directory holds only a HEAD ref and the staging area (`index.json`), because the commits live in IPFS.

Work like git: stage files, commit, push.

```sh
fangorn repo init rusty-anchor
fangorn add .                     # stage files and folders (dot entries skipped)
fangorn rm t0                     # stage a delete, by record id
fangorn status                    # local vs on-chain tip, and what's staged
fangorn commit                    # commit the staging area (additive), then clear it
fangorn commit --replace          # the staged records *are* the new state; history is kept
fangorn push
fangorn push --force              # push even if it doesn't fast-forward the on-chain head
```

`add` turns each file into records:

| File                                      | Records                                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `.csv`, `.jsonl`/`.ndjson`, `.json` array | One per row. `id` from the `id` column (`--id-column`), else `path#row`. Type is the file name (`tracks.csv` → `tracks`) |
| `.json` object                            | One record, `id` = its path                                                                                              |
| `.json` with `records`/`deletes`          | Passed through as-is (format below)                                                                                      |
| Any other text (`.txt`, `.md`, …)         | One record: `id` = its path, type `file`, payload `{ path, text }`                                                       |
| Binary                                    | Skipped with a warning                                                                                                   |

`--type <type>` sets the type for everything added. Re-adding a file replaces the staged records with the same ids. CSV values stay strings. Ids are paths relative to the repo root, with spaces made `_`. Deleting a file doesn't stage a delete; to make the folder the whole state, `fangorn add . && fangorn commit --replace`. To unstage everything, delete `.fangorn/index.json`.

You can also skip staging and commit a file directly: `fangorn commit records.json`.

```json
{
	"records": [
		{
			"id": "t1",
			"type": "track",
			"payload": { "title": "Locura", "artist": "Alice" }
		},
		{ "id": "a1", "type": "artist", "payload": { "name": "Alice" } }
	],
	"deletes": ["t0"]
}
```

If a record has no `id`, one is generated. A record with an existing `id` overwrites that record.

### SDK

```ts
await fangorn.initRepo("rusty-anchor"); // idempotent
const tip = await fangorn.onChainTip(fangorn.getAddress(), "rusty-anchor");

const c1 = await fangorn.commit({
	repo: "rusty-anchor",
	parent: tip!,
	records: [{ id: "t1", type: "track", payload: { title: "Locura" } }],
});
await fangorn.push("rusty-anchor", c1.commitCid);

const c2 = await fangorn.commit({
	repo: "rusty-anchor",
	parent: c1.commitCid,
	records: [],
	deletes: ["t1"],
});
await fangorn.push("rusty-anchor", c2.commitCid);
```

`upload` (one record) and `uploadBatch` (many records, plus deletes) commit and push in one call:

```ts
await fangorn.upload("rusty-anchor", { title: "Locura" }, "track");
await fangorn.uploadBatch(
	"rusty-anchor",
	[{ id: "t1", type: "track", payload: { title: "Locura" } }],
	["t0"],
);
```

To have a relayer pay gas, call `signPush(repo, commitCid)` and give the result to `relayPush(signed)`.

### Epochs

Every commit carries an **epoch**, the hour it was made: `floor(unix seconds / 3600)` (`EPOCH_SECONDS`, `epochOf`). The registry accepts a push only if the commit's epoch is no later than the current block's and no more than 24 epochs (`WINDOW`) behind it. Otherwise the push reverts with `EpochOutOfWindow`, and you have to commit again.

The epoch serves two purposes:

- **It prevents late replay.** A relayer can delay a signed commit, but it can't land it more than a day later.
- **It dates the commit.** The epoch is hashed into the head, so any reader knows when the commit was made, to within a day, without a timestamp service.

The full argument is in [WHITEPAPER_1](WHITEPAPER_1.md) §3.2.

---

## Read, history, clone

```sh
fangorn status                     # local tip vs on-chain tip
fangorn log -n 5                   # history, newest first
fangorn show [commitCid]           # a commit and its diff from the parent
fangorn read rusty-anchor --owner 0x... --pretty   # every record, as JSON
fangorn clone <owner> rusty-anchor [--dir ./somewhere]
```

```ts
const tip = await fangorn.onChainTip("0x...", "rusty-anchor");
for await (const c of fangorn.log(tip!)) console.log(c.cid, c.epoch);
const { puts, deletes } = await fangorn.show(tip!);

const { records } = await fangorn.inspectRepo("rusty-anchor"); // your own repo
const { tip: head, contents } = await fangorn.readRepo("0x...", "rusty-anchor"); // anyone's
```

To diff two arbitrary roots, use `engine.repoDiff(oldRootHex, newRootHex)`.

---

## Subscribe

`subscribe` acts as a light client, with no indexer and no subgraph. Each `publisher:repo` pair is its own timeline in the registry's `Updated` event. `subscribe` reads that timeline from the RPC and diffs each new head against the previous one, fetching one CAR per push.

```sh
fangorn subscribe                              # the repo tracked here
fangorn subscribe rusty-anchor --owner 0x...   # any publisher's repo
fangorn subscribe --all                        # every repo; a name or --owner narrows it
fangorn subscribe --from-block 12000000        # or --from-start for the full history
```

The CLI saves its cursor to `.fangorn/subscribe-<owner>-<repo>.json`. Without a cursor it starts live from the current tip, so seed your index with `fangorn read` first.

Each change is one JSON line:

```jsonc
{
	"repo": "rusty-anchor",
	"owner": "0x...",
	"commitCid": "bafy...",
	"oldRoot": "0x...",
	"newRoot": "0x...",
	"blockNumber": "12345678", // persist this to resume
	"puts": [
		{
			"id": "t1",
			"cid": "bafy...",
			"type": "track",
			"payload": { "title": "Locura" },
		},
	],
	"deletes": ["t0"],
}
```

```ts
const controller = new AbortController();
for await (const change of fangorn.subscribe({
	repo: "rusty-anchor",
	owner: "0x...",
	fromBlock: saved,
	signal: controller.signal,
})) {
	for (const r of change.puts) index.upsert(r.id, r.payload);
	for (const id of change.deletes) index.remove(id);
	persistCursor(change.blockNumber);
}

fangorn.subscribeAll({ repo: "reviews" }); // every publisher's "reviews" repo
fangorn.subscribeAll({ owner: "0x..." }); // every repo of one publisher
fangorn.feed(); // one shared stream for many consumers
await fangorn.repos({ repo: "reviews" }); // every matching repo's latest head
```

---

## Agent cards

A repo can point at an A2A agent card so that agents can find it. The pointer is a record in the repo, `@card` holding `{ url }`, and only the publisher can commit it. The card points back at the repo through the `FANGORN_REPO_EXTENSION` extension:

```jsonc
{
	"name": "Picks",
	"capabilities": {
		"extensions": [
			{
				"uri": "https://fangorn.network/a2a/repo/v1",
				"params": {
					"chainId": 84532,
					"dataRegistry": "0x…",
					"publisher": "0x…",
					"repo": "picks",
				},
			},
		],
	},
}
```

```ts
await fangorn.registerAgent(cardUrl, { repo: "picks" }); // commits @card and registers with ERC-8004
await fangorn.setCard("picks", cardUrl); // commits @card only
const { card, publisher, repo } = await fangorn.discoverCard(cardUrl); // verifies both directions
```

The CLI equivalent is `fangorn card <url> [--repo picks] [--skip-register]`.

---

## Storage

You bring your own storage. Each commit is stored as one CAR file plus one commit block, and the chain holds only the commit pointer. Pass one of these to `Fangorn.create`:

| `storage`                      | Notes                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `{ signedUrl: {} }`            | Hosted uploads through the network's worker. No JWT is needed, and uploads count against the signer's quota. |
| `{ pinata: { jwt, gateway } }` | Your own Pinata account.                                                                                     |
| `{ backend }`                  | Any `MetadataStorage` implementation. The backend never needs to understand IPLD.                            |

---

## Sealed and paid fields

Records, ids and types are always public. A field's _value_ can be sealed: the record then holds an opaque reference to it, and a **gadget** says how the value opens.

| Gadget         | Key                                 | Who can open it                                                                  |
| -------------- | ----------------------------------- | -------------------------------------------------------------------------------- |
| `self-hkdf-v1` | HKDF from your own 32-byte secret   | Only you. No server is involved.                                                 |
| `field-v1`     | a per-repo key held by a key server | Anyone who paid for the record, or for the whole repo, in the SettlementRegistry |

### `self-hkdf-v1`: private to you

You seal the value before committing and unseal it after reading. Fangorn sees only ciphertext.

```ts
import {
	sealSelf,
	unsealSelf,
	GADGET_SELF_HKDF_V1,
} from "@fangorn-network/sdk";
import { keccak256, stringToBytes, hexToBytes, bytesToHex } from "viem";

const secret = hexToBytes(privateKey);
const resourceId = keccak256(stringToBytes("rusty-anchor:secret-msg"));
const ciphertext = sealSelf(
	new TextEncoder().encode("the eagles are coming"),
	secret,
	resourceId,
);

await fangorn.upload(
	"rusty-anchor",
	{
		gadget: GADGET_SELF_HKDF_V1,
		resourceId,
		ciphertext: bytesToHex(ciphertext),
	},
	"secret-msg",
);

const plaintext = unsealSelf(
	hexToBytes(stored.ciphertext),
	secret,
	stored.resourceId,
);
```

### `field-v1`: paid fields

**Keys.** Each repo has one random repo key per _generation_. Raising the generation with `raiseGeneration` voids old prices. A separate key is derived from the repo key for every record, so selling one record reveals nothing about the others. The publisher seals the repo key to a key server and commits the result as a public record, `@deposit/<generation>`.

After a buyer pays, the key server releases either the record key or, for a whole-repo purchase, the repo key. It seals the key to a throwaway key the buyer generates. The key server stores nothing and checks `canRead` on every request. Every key and deposit is bound to `(chainId, settlementRegistry, publisher, repo, generation)`.

**Publish, the short way.** `sealRecords` does every step below in one call: it reuses the repo's deposit or makes one, seals the named fields (each value as JSON), and signs terms for each record. The CLI does it on commit:

```sh
fangorn commit records.json --paid body --price 0.01   # --share 0 (percent), --deadline-days 365, --key-server <url>
fangorn push
```

```ts
const records = await sealRecords(fangorn, "rusty-anchor", input, {
	fields: ["body"],
	price: 10_000n,
	shareBps: 0,
	deadline,
	keyServer,
});
await fangorn.uploadBatch("rusty-anchor", records);
```

Push before sealing more: the deposit is read from the on-chain head, so the CLI refuses a paid commit on top of unpushed ones. `shareBps` goes to the sale's referrer. Fangorn's relay names its treasury as referrer, but takes nothing unless the publisher signs a share; the default is 0.

**Publish, step by step.** The record holds a handle (`{ "@type": "handle", "gadget": "field-v1", "generation": "0", "cid": "bafy…" }`) and the publisher's signed terms. The terms set the price and the referral share (`shareBps`), which goes to whichever app (citing publisher) referred the sale.

```ts
import {
	makeDeposit,
	newRepoKey,
	recordKey,
	repoId,
	sealField,
	termsToJson,
} from "@fangorn-network/sdk";

const settlement = fangorn.getSettlementRegistry();
const repo = repoId("rusty-anchor");
const scope = {
	chainId: fangorn.getConfig().chain.id,
	registry: settlement.getAddress(),
	publisher: fangorn.getAddress(),
	repo,
	generation: await settlement.generationOf(fangorn.getAddress(), repo),
};

const kRepo = newRepoKey();
const deposit = makeDeposit({
	kRepo,
	keyServerPubkey,
	keyServer: KEY_SERVER_URL,
	scope,
});
const body = await sealField({
	plaintext: new TextEncoder().encode("the eagles are coming"),
	kRepo,
	scope,
	key: recordKey("a"),
	field: "body",
	storage: fangorn.getStorage(),
});
const terms = await settlement.signTerms({
	repo,
	key: recordKey("a"),
	price: 10_000n,
	shareBps: 0,
	deadline,
});

await fangorn.uploadBatch("rusty-anchor", [
	{
		id: "a",
		type: "note",
		payload: { title: "a paid note", body, "@terms": termsToJson(terms) },
	},
	{ id: `@deposit/${deposit.generation}`, type: "deposit", payload: deposit },
]);
```

You don't need to keep `kRepo`. The key server always serves a request the publisher signs: `requestKey({ deposit, key: WHOLE_REPO, signer })`.

**Buy and read.** The buyer calls `register` with the signed terms, an ERC-3009 USDC authorization and a Semaphore identity commitment. The buyer then calls `settle` with a Semaphore proof that names the reading address. Anyone can submit either transaction. After that:

```ts
const plaintext = await openField({
	handle: record.body,
	deposit,
	key: recordKey("a"),
	field: "body",
	signer,
	storage,
});
```

A whole-repo buyer calls `requestKey` once, then calls `deriveRecordKey` and `decryptField` for each record.

**Run a key server.** Deploy [fangorn-access-worker](https://github.com/fangorn-network/webworker/tree/main/fangorn-access-worker). Its `POST /access` is the whole key server.

**Trust model.** A key server could unseal any deposit made to it. It is trusted not to do that, and not to release keys to anyone who hasn't paid. It never sees the content itself. If you don't want to trust the hosted key server, run your own and commit a deposit that names it.

---

## Network config

Fangorn runs on Base Sepolia. `BaseSepoliaConfig` (also exported as `FangornConfig`) is in [`src/config.ts`](../src/config.ts). Any other deployment, such as anvil, is a `NetworkConfig` you pass yourself. The contracts work as follows:

- **DataRegistry** holds every repo's head and the update log.
- **SettlementRegistry** holds signed per-record prices, referral splits, and read access (USDC and Semaphore).
- The two contracts don't call each other.

Base Sepolia's default RPC is `base-sepolia-rpc.publicnode.com`. The official `sepolia.base.org` endpoint caps `eth_getLogs` at 200 blocks, which is too few to scan the registry's history. Each config's `logWindow` is the largest block range one log query may span on its RPC.

---

## Limitations

- You choose which fields to seal on each call. There is no schema-level hint for this and no CLI command for sealing.
- The SDK doesn't depend on any prover. Buyers bring their own Semaphore identities and proofs.
- `field-v1` trusts the key server. A TEE- or threshold-backed key server would ship as a new gadget.
- Record schemas are validated client-side only.
