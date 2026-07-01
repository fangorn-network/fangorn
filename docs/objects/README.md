# Shared object spec (Slice 0)

Fangorn stores data as a Merkle DAG in IPFS, the same shape git uses for code:

- **blob** — one immutable chunk of records/nodes/edges, named by the hash of its
  bytes. These already exist as the chunk CIDs the publisher uploads.
- **tree** — a snapshot: the set of blobs that make up the dataset at one moment,
  plus one Poseidon2 root that fingerprints the whole set. In v1 an existing
  *manifest* (record-set / bundle / view / linkset) already *is* the tree — it lists
  the blob CIDs and carries the root. We wrap it, not reinvent it.
- **commit** — a tree plus provenance: who, when, the parent it was built on, the
  schema it conforms to, and (optionally) the embedding contract the indexer should
  use. This is the one genuinely new object.

The TypeScript SDK/CLI (`fangorn/src/objects/`) and the Python indexer
(`embeddings/quickbeam/objects.py`) must serialize and parse these objects
**identically**, or the two sides can't agree on object identity. That agreement is
what this directory pins down.

## Canonical bytes

A commit's CID is a pure function of its logical contents. To get the same bytes on
both sides, objects are serialized through a canonicalizer, not plain `JSON.stringify`
/ `json.dumps`:

- object keys sorted lexicographically, recursively
- no insignificant whitespace (`,`/`:` separators, nothing else)
- keys whose value is `undefined`/`None` are dropped
- non-ASCII kept literal (UTF-8), never `\uXXXX`-escaped
- `Uint8Array`/`bytes` encoded as `{"__type":"Uint8Array","data":"<base64>"}`

## Golden fixture

`commit.fixture.json` is the logical commit; `commit.canonical.txt` is the exact
canonical byte string it must produce. Both repos check the fixture in and assert
their canonicalizer reproduces `commit.canonical.txt` byte-for-byte:

- TS: `src/objects/objects.test.ts` → "S0 golden fixture"
- Python: `quickbeam/test_objects.py` → `test_golden_fixture_parity`

Regenerate the golden bytes from the source of truth (the TS canonicalizer) if the
object shape ever changes:

```bash
cd fangorn && npx tsx -e '
  import { canonicalize } from "./src/objects/canonical.ts";
  import { readFileSync } from "fs";
  process.stdout.write(canonicalize(JSON.parse(readFileSync("docs/objects/commit.fixture.json","utf8"))));
' > docs/objects/commit.canonical.txt
cp docs/objects/commit.* ../embeddings/tests/fixtures/
```
