# Fangorn SDK

Fangorn is git for published data. You publish **repos** of records, and you can make any field paid. Each repo's head is anchored on chain and its history lives in IPFS. Anyone can read, verify, diff, subscribe to, or buy from your repos without asking you, an indexer, or a platform.

```sh
npm i @fangorn-network/sdk
```

## The model

- **Publisher.** A wallet address. Publishers own their repos, and nobody admits or approves them.
- **Repo.** Keyed `publisher : repo`. Its state is a map of **records** `{ id, type, payload }`, stored as a content-addressed Merkle search tree.
- **Commit.** Each commit points at its parent and at one CAR file holding the blocks it introduced. History can be walked and diffed from the head alone.
- **Push.** Moves the on-chain head with a compare-and-swap on the parent, like a git ref update. The registry stores only heads.
- **Paid fields.** A publisher seals a field and signs a price for it in the record. Buyers pay through the SettlementRegistry, and a key server releases the key.
- **Apps are just repos.** An app is a publisher's repo of records that **cite** other publishers' records at named heads. It selects and arranges data, but it never holds or gates that data. When a citation leads to a sale, the app's publisher address receives the referral share.

What Fangorn is not: it is not a database. It has no query language and no indexer. You build those on top with `subscribe` (see [westmarch](https://github.com/fangorn-network/westmarch)).

## Quickstart (SDK)

```ts
import { Fangorn } from "@fangorn-network/sdk";

const fangorn = Fangorn.create({
	privateKey: "0x...",
	storage: { signedUrl: {} }, // hosted uploads on Base Sepolia; or { pinata: { jwt, gateway } }
});

await fangorn.initRepo("rusty-anchor");
await fangorn.uploadBatch("rusty-anchor", [
	{ id: "t1", type: "track", payload: { title: "Locura", artist: "Alice" } },
]);

// Anyone, from the head alone:
const { contents } = await fangorn.readRepo(
	fangorn.getAddress(),
	"rusty-anchor",
);

for await (const change of fangorn.subscribe({
	repo: "rusty-anchor",
	owner: fangorn.getAddress(),
})) {
	console.log(change.puts, change.deletes);
}
```

## Quickstart (CLI)

```sh
npm i -g @fangorn-network/sdk
fangorn init                       # wallet key, storage → ~/.fangorn/config.json
fangorn repo init rusty-anchor     # create on chain, track in ./.fangorn
fangorn add .                      # stage files: csv/json rows → records, text files → one record each
fangorn commit                     # local commit (IPFS only)
fangorn push                       # move the on-chain head
fangorn subscribe --owner 0x... rusty-anchor   # stream diffs as JSON lines
```

The [Guide](docs/GUIDE.md) covers the full flow: commit vs push, epochs, history, subscribing, agent cards, storage, and sealed and paid fields.

## Network

Fangorn runs on **Base Sepolia**. The DataRegistry, SettlementRegistry, and hosted upload worker are all deployed there. Addresses are in [`src/config.ts`](src/config.ts) (`BaseSepoliaConfig`). To use a local anvil or a private deployment, pass your own `NetworkConfig` to `Fangorn.create`, or set the `FANGORN_*` overrides for the CLI (see the [Guide](docs/GUIDE.md#configure)). Contract sources are in [fangorn-network/contracts](https://github.com/fangorn-network/contracts).

## Development

```sh
pnpm i
pnpm test        # unit tests + the SDK suite in memory
pnpm test:e2e    # the same suite against the contracts on a fresh anvil
pnpm abis        # regenerate ABIs from the contracts repo
```

The e2e tests need `anvil`, `forge`, and a sibling checkout of `fangorn-network/contracts` (set `FANGORN_CONTRACTS_DIR` to use another location). Without them, the tests are skipped locally and fail in CI. `E2E_STORAGE=pinata` runs the tests against Pinata (`PINATA_JWT`, `PINATA_GATEWAY`). `pnpm test:live` runs read-only checks against Base Sepolia.

## License

MIT
