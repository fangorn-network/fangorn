# DataSources as Git Repositories

*Redefining Fangorn's data model: datasets are repositories, manifests are commits,
the registry stores refs, IPFS stores history — driven by a git-like CLI, gated by
on-chain push auth, and tethered to the embeddings builder (quickbeam).*

Status: **design v0.2** · Scope: `fangorn` SDK + CLI, `contracts/stylus`,
`embeddings`/quickbeam · Companion to [`FRAMEWORK.md`](./FRAMEWORK.md).

Locked with the owner:
- **One coordinated cut** (contract + SDK/CLI + quickbeam).
- **Single ref per repo** with parented history + CAS (branches deferred).
- **Snapshot-tree commits** with content-addressed structural sharing.
- **CLI is the primary entry point** for data; `commit` is local, `push` is the
  on-chain, authorized ref update.
- **Schemas stay** — they are orthogonal to repos, not replaced by them.

---

## 0. Why change

Today's on-chain state is **last-write-wins with a version counter**, not a log:

```rust
data_sources: owner → schema_id → name_hash → StorageDataSource {
    manifest_cid, merkle_root, price_root, name, version
}
```

`publish()` overwrites the slot and does `version += 1`. History exists only as the
subgraph event stream. Five rigidities follow: (1) manifests carry no **parent**, so
version N isn't cryptographically descended from N−1 — ordering is trusted from the
indexer; (2) **no deletes** — quickbeam dedups by `processed_track_ids` and never
removes (`watcher.py:171`); (3) **one linear chain** per repo; (4) **blind writes** —
`version = get()+1` with no compare, so concurrent writers clobber; (5)
**re-embed-the-world** builds, since there's no commit diff.

**The rigidity is in the ref model, not the schema model.** We keep shapes strict
(they drive relationships + embeddings) and make *history* flexible.

---

## 1. Two orthogonal axes: repo and schema

The redesign turns one conflated concept into two independent ones:

| Axis | Question it answers | Artifact | Mutable? |
|---|---|---|---|
| **Schema** | *What shape / meaning does this data have?* | Schema Registry (`schemaId → specCid`); resolver \| bundle \| view \| linkset | new `schemaId` per version (immutable spec) |
| **Repo** | *Where does this data live and how did it get here?* | DataSource Registry (`resourceId → ref → commit DAG`) | ref moves; history immutable |

A **repo conforms to a schema** — the schema is the repo's *type*. A **commit**
declares the exact `schemaId` its contents conform to. `fangorn commit -s
music.catalog.v1` reads as *"commit into the repo typed by this schema,"* never *"use
a schema instead of a repo."* Strict schemas + flexible history are complementary,
not in tension.

**v1 keying is unchanged:** `resourceId = keccak256(owner ‖ schemaId ‖ keccak256(name))`
— a repo is schema-scoped, so the SettlementRegistry join key and pricing plumbing
keep working untouched. (Schema *evolution* within one repo — letting `schemaId`
float per commit and decoupling the key — is an explicit v2 question, §9.)

### The git mapping

| Git | Fangorn today | Fangorn (this design) |
|---|---|---|
| Repository | `(owner, schemaId, name)` → `resourceId` | **unchanged** — `resourceId` is the repo id |
| Commit | *absent* (manifest is unlinked) | Commit object in IPFS: `{parents[], tree, root, schemaId, author, ts, message, embed, build}` |
| Tree / blobs | manifest `{nodeChunks, edgeChunks}` + chunk CIDs | manifest *becomes* the commit's `tree`; chunk CIDs are blobs |
| Ref (`HEAD`) | mutable `manifest_cid` slot | on-chain tip **commit CID**, moved by authorized CAS |
| `git log` | replay subgraph events | walk `parents` in IPFS — self-verifying, no indexer |
| Object push vs ref update | one `publish` tx | **`commit` (permissionless, IPFS)** vs **`push` (authorized, on-chain)** |
| Packfile dedup | none (re-pin) | content-addressing: unchanged chunk CIDs reused for free |

---

## 2. Commit topologies (this is where cross-repo linking lives)

Views and linksets stop being separate manifest `kind`s bolted onto the model and
become **commit topologies**. "Cross-repo ref" is not obviated by the git redesign —
it becomes *native*.

- **Bundle commit** — `parents = [prev tip in the same repo]`. A normal commit. Tree
  = nodeChunks + edgeChunks (today's `BundleManifest`).
- **View commit** — `parents = [tip(repoA), tip(repoB), …]`: a **merge commit whose
  parents are the tips of *different repos***. *This is the cross-repo ref, now
  first-class.* The fuse (union-find on Entity URIs/aliases) is what the merge
  *means*; the commit records exactly which source tips were fused.
- **Linkset commit** — `parents = [prev tip in the linkset repo]`, but its **content
  is edges pointing at foreign Entity URIs** (`fangorn:<otherResourceId>/<localId>`)
  — submodule-like cross-repo content references. Feeds the same union-find a view
  merge already uses.

So: a **view = a cross-repo merge**, a **linkset = a repo of cross-repo edges**. Both
were needed before and are still needed — the semantic-web "web" survives as
commit-graph structure instead of bespoke manifest kinds.

### 2.1 Commit object

```jsonc
{
  "kind": "commit",
  "parents": ["bafy…"],        // [] initial; 1 normal; ≥2 = view/merge across repos
  "tree": "bafy…",             // CID of the tree (the manifest below)
  "root": "0x…",               // Poseidon2 merkle root (denormalized on-chain)
  "schemaId": "0x…",           // exact schema version this commit conforms to
  "author": "0x…",             // msg.sender, OR a Semaphore pseudonym (see §4)
  "timestamp": 1719800000,
  "message": "add 10k tracks; retract 3 stale venues",
  "embed": { "model": "nomic-…v1.5", "dim": 256, "distance": "cosine" }, // Gap A
  "build": { "profiles": [ /* root-type projections */ ], "maxDepth": 2 } // reproducible
}
```

The **tree** is today's manifest (`BundleManifest`/`Manifest`/`ViewManifest`/
`LinksetManifest`), promoted to a content-addressed object. Chunk refs are stable
CIDs (already true), so unchanged chunks are shared across commits with zero re-pin.
**Diff** = set-difference on `dataCid` between `A.tree` and `B.tree`.

---

## 3. CLI: the entry point

Git's porcelain, mapped onto Fangorn. A repo has a local `.fangorn/` (like `.git/`)
holding config (`owner`, `schemaId`, remote) and a local `HEAD` (last commit CID).

```bash
# ── create / clone ─────────────────────────────1
# bind cwd to a repo (schema = its type)───────────────────
fangorn init music-catalog -s music.catalog.v1   
# fetch commit + tree into a local repo
fangorn clone <owner>/music.catalog.v1           

# ── the commit/push split (the core idea) ─────────────────────────
# stage input (optional)
fangorn add data.jsonl                           
# build tree+commit, pin to IPFS, move LOCAL HEAD
fangorn commit -m "add 10k tracks"               
# update on-chain ref via CAS  ← AUTH HERE
fangorn push                                     
# local HEAD vs on-chain tip (ahead/behind)
fangorn status                                   
# walk parents in IPFS
fangorn log                                      

# ── cross-repo (views + linksets) ─────────────────────────────────
# a view repo (merge commits)
fangorn view create local.view -s placesRid eventsRid   
# stage a cross-repo edge → linkset commit
fangorn link add fangorn:<A>/x sameAs fangorn:<B>/y      
```

**Why split `commit` from `push`?** It maps git's permission model exactly and puts
authorization where you want it:

- `commit` is **permissionless**: it chunks, builds the tree + commit object, and
  pins to IPFS. Pinning is content-addressed — anyone can pin anything; no trust
  boundary is crossed. It only advances a *local* pointer.
- `push` is **authorized**: it submits `update_ref(expectedOld, newCid)` on-chain.
  This is the single trust boundary. A rejected push (failed auth or non-fast-forward
  CAS) leaves the on-chain ref untouched; your local commits still exist in IPFS.

`fangorn commit -m "…" -s "…"` from the prompt is the sugar path: with `-s` (or a
`.fangorn` already bound) it does commit, and — if `--push`/config says so — push in
one shot. The two-phase model underneath is what makes auth, offline work, and
non-fast-forward detection clean.

---

## 4. Push authorization (on-chain, pluggable per repo)

Auth is enforced in `update_ref` (i.e. at `push`). The **write policy is a property
of the repo**, because both primitives already exist in the codebase:

| Policy | Mechanism | `author` | Cost | Status of primitive |
|---|---|---|---|---|
| **owner-only** | `msg.sender == repo.owner` | address | trivial | default |
| **allowlist** | Schema Registry `isPublisher(schemaId, sender)` | address | 1 SLOAD | **exists** (`addPublisher`/`isPublisher`) — FRAMEWORK Gap D, currently unwired |
| **group (anonymous)** | Semaphore membership proof + nullifier, via relayer | pseudonym (identity commitment) | proof verify | **exists** — the consumer *settle* flow already does group create / relayer join / `generateProof` / nullifier / group-reconstruction |

The **group** policy is exactly *"push is rejected if you're not in the Semaphore
group."* A contributor proves membership in the repo's **writer group** without
revealing which member; the relayer submits the tx so gas doesn't dox them — the same
pattern `SettlementRegistry.register/settle` uses, pointed at writes instead of reads.

**Wiring:** `create_repo` records a `write_policy` enum + optional `writer_group_id`.
`update_ref` branches on it: owner check, or `RawCall` to the Schema Registry's
`isPublisher` (reusing the existing cross-contract call pattern in `publish`), or
verify a Semaphore proof against the writer group's root. Default **allowlist** closes
Gap D for free; **group** is opt-in for repos wanting unlinkable / collective authorship.

**Open detail (anonymous mode):** with a single mutable ref + CAS, the nullifier must
be scoped so one member can push *many* commits (external nullifier bound to the new
commit CID or a monotonic counter) rather than once-per-repo. Spelled out in §9.

---

## 5. Contract redesign (`contracts/stylus`)

Single-ref, so storage stays close to today — swap the snapshot slot for a
CAS-guarded, policy-gated tip pointer and record the parent for provenance.

```rust
#[storage]
pub struct StorageRepo {
    pub head_cid: StorageString,              // tip commit CID (the ref)
    pub merkle_root: StorageFixedBytes<32>,   // denormalized from tip commit
    pub price_root: StorageFixedBytes<32>,
    pub name: StorageString,
    pub commit_count: StorageU64,             // replaces `version`
    pub write_policy: StorageU8,              // 0=owner 1=allowlist 2=group
    pub writer_group_id: StorageFixedBytes<32>,
}
// keying (owner → schema_id → name_hash → StorageRepo) UNCHANGED.
```

Methods:
- `create_repo(schema_id, name, write_policy, writer_group_id)` — schema-existence
  check + (for allowlist) `add_publisher`, splits repo creation from ref updates.
- `update_ref(schema_id, name, expected_old_cid, new_commit_cid, merkle_root, price_root, auth)`
  — **(a)** enforce `write_policy` against `auth` (sender / `isPublisher` / Semaphore
  proof); **(b)** CAS: require `head_cid == expected_old_cid` (empty on first commit)
  else revert `NonFastForward`; **(c)** set tip, denormalize roots, bump
  `commit_count`, emit `RefUpdated`.
- Reads: `read_ref`, plus existing `get_merkle_root` / `get_price_root` / `get_name` /
  `resource_id` **unchanged** — SettlementRegistry keeps resolving with zero changes.

```solidity
event RefUpdated(
    address indexed owner, bytes32 indexed schema_id, bytes32 indexed name_hash,
    string old_commit_cid, string new_commit_cid,
    bytes32 merkle_root, bytes32 price_root, uint64 commit_count
);
```

---

## 6. SDK changes (`fangorn`)

- **`datasource-registry/index.ts`**: `createRepo`, `updateRef` (with the `auth`
  payload variants), `readRef`. Keep `resourceId`/`hashName`.
- **`publisher/index.ts`** — the publish path (`publish()`, `~index.ts:67-156`) splits:
  - **commit**: `readRef` → fetch parent commit+tree (empty on first) → chunk, but
    **skip re-pinning chunks whose CID is already in the parent tree** → assemble the
    tree (existing builder `assemble()`) → wrap in a commit (`parents`, `embed` from
    schema, `build`, `message`) → pin commit → advance local HEAD.
  - **push**: `updateRef(expectedOld = parentCid, newCid = commitCid, root, priceRoot,
    auth)`. On `NonFastForward`, surface a rebase-style error.
- **New porcelain surface**: `init/commit/push/status/log/clone`, `view create`,
  `link add`, plus `commit`/`log`/`show` on `PublisherRole`.
- `CommitInfo` (`builders/types.ts:40`) carries `parentTree` for delta-aware builders
  (bundle); others ignore it, matching the existing optional pattern.
- View commit = `publishView` producing `parents = [source tips]`; linkset commit =
  `publishLinkset` with foreign-URI edge content — both now just parent/content
  variants of the same commit path.

---

## 7. Tethering quickbeam

- **Commit-diff builds.** On `RefUpdated A→B`, diff `A.tree` vs `B.tree`: added chunks
  → embed; removed chunks → tombstone (fixes delete propagation, §0#2). Replaces
  `processed_track_ids`.
- **Embedding contract inheritance (Gap A).** Read `commit.embed.{model,dim,distance}`
  instead of the ~5 hardcoded sites (`embeddings.py`, `watcher.py:124`, `server.py`,
  `cdn.py`, browser).
- **Build spec on the commit.** `commit.build.profiles` replaces CLI
  `--root-profile`/`--root-type`/`--max-depth`, making builds reproducible.
- **Trigger.** `RefUpdated` is the wake signal (replaces the 60s poll); read both
  commit CIDs from the event and diff.
- **View merges natively.** A view commit's `parents = [source tips]` *is* the fuse
  input — quickbeam walks the parents instead of re-deriving sources from a manifest.
- **Index-as-a-repo.** The CDN bake (`cdn.py`) becomes a commit in a sibling *index
  repo* annotating the **source data commit CID** it was built from: data commit →
  build → index commit pointing back at its input. Versioned, reproducible lineage.

---

## 8. Migration

- **Backfill, no reshuffle.** Each `(manifest_cid, version=N)` → an initial `HEAD`
  commit, `parents:[]`, existing manifest as tree; pin, set `head_cid`,
  `commit_count=N`, `write_policy=allowlist` (retroactively closing Gap D).
- **Contract**: redeploy with new storage; keying + price/merkle read signatures
  preserved → SettlementRegistry and existing consumers keep working.
- **Subgraph**: index `RefUpdated`; keep mapping the first commit to the old
  `ManifestPublished` handler for continuity, or migrate wholesale.
- **quickbeam checkpoint**: `last_block` stays the event cursor; `processed_track_ids`
  retired for commit diffs.

---

## 9. Execution plan & open questions

Sequencing (one cut): **object model (SDK) → contract + registry client (∥) →
CLI porcelain → quickbeam → index-as-repo → migration.** Item 1 is pure addition
(no redeploy) and de-risks the rest.

Open decisions:
1. **Schema evolution within a repo.** v1 keys the repo by `schemaId` (repo =
   schema-scoped). To let a repo migrate schemas across commits, decouple the key
   (`repoId = keccak(owner ‖ name)`, `schemaId` per commit) — but that touches the
   universal join key. v2, or accept "new schema = new repo + migration linkset"?
2. **Views as merge commits — now or later?** `parents[]` ≥2 supports it; do we model
   views this way in v1 or keep the current view artifact and revisit?
3. **Anonymous-push nullifier scope.** External nullifier bound to commit CID vs.
   monotonic counter, so a group member can push many commits, not one.
4. **Re-price path.** Is `set_price_root` a real (empty-diff) commit or a side channel
   that leaves `head_cid` untouched?
5. **Force-update / rollback.** With a single ref, do we allow non-fast-forward moves,
   and gated how?
6. **Commit signing.** `author` is `msg.sender`/pseudonym — should the commit object
   also carry a detached signature so off-chain verification needs no chain read?
