# Prior Art & Tooling — What to Borrow, What to Reject

*A structured scan of the projects that already solved pieces of our invariants, the
tools that could accelerate the slices, and the new architectural decisions that fall
out of taking them seriously. Companion to [`GIT_NATIVE_REDESIGN.md`](./GIT_NATIVE_REDESIGN.md).*

The point of this doc is **not** "use these because they exist." It's to (a) steal the
data structures that already handle our hard cases, (b) name where a tool is a genuine
build-vs-buy fork, and (c) surface the decisions we hadn't yet made explicit — the
biggest being **what the Tree object actually is** (a flat leaf list does not survive
contact with million-row commit-diffs).

---

## 1. Prior art, mapped to our invariants

| Project | What it is | Invariant/slice it informs | Concrete takeaway → our verdict |
|---|---|---|---|
| **LakeFS (Graveler)** | Git-over-S3; commits point at a **metarange → ranges** (content-addressed SSTables of key→object) | I4, S1, S2 | Two-level ranged tree makes commit-diff = compare **range CIDs**, skipping untouched ranges. **Adopt the shape**: our Tree must be a ranged/paged structure, not a flat leaf list. |
| **Dolt (Prolly Trees)** | A relational DB you `git commit`; cell-level history via a **probabilistic B-tree / Merkle Search Tree** with content-defined chunk boundaries | I1–I4, S1, S2, S4 | Prolly trees are *history-independent* (same content ⇒ same root regardless of insert order) and give **log-scale diff + 3-way merge**. **Adopt**: the dataset Tree is a Prolly tree. This is the single highest-leverage borrow — see Decision 11. |
| **Oxen.ai** | ML-data VCS; Merkle tree over the data dir + block-level dedup, tuned for large files | I4, S1 (handles) | Block-level dedup for large/binary **handle** payloads (our sealed blobs). **Adopt** for the handle-blob path; complements Prolly trees for tabular rows. |
| **Ceramic** | Mutable **streams** over immutable IPLD commit logs; genesis + **signed** commits + **anchor** commits (batched on-chain timestamp); schema commits | I2, I5, I8, S1, S3 | Three lessons: (1) commits are **DAG-JOSE signed envelopes** → our open decision #6 (detached signatures) should default *on*; (2) **anchor batching** amortizes thousands of tip updates into one on-chain tx → Decision 14 (gas); (3) their conflict rule is *tip-selection*, ours is stricter *CAS-reject* — keep CAS, but note anchoring changes the concurrency picture. |
| **Qri** *(archived, public)* | P2P dataset VCS on IPFS; dataset = **body + structure(schema) + meta + commit + transform + viz**, each content-addressed, linked in a DAG; git-like CLI | I7, S0, S1, CLI | Validates our **shape⟂history split** at the object level (their `structure` = our schema binding). **Borrow** the componentized dataset DAG and the CLI verb set (`init/save/checkout/push/publish`) as a blueprint for S0/S1. |
| **Radicle (Heartwood)** | Git-native P2P code collab; **signed refs**, per-peer ref namespaces, CRDT "collaborative objects" | I2, I5, S3, S6 | Proves refs-as-signed-identity. **Borrow** signed refs (reinforces detached signatures) and per-identity ref namespacing as the eventual model for **branches** (Decision 3) and multi-writer without a central owner. |

**Net structural change:** the theory docs describe the Tree as "an ordered set of
`LeafRef`." That's fine for kilobyte datasets and wrong for the places/music scale. LakeFS
and Dolt both independently converged on a **paged, content-addressed, self-balancing
tree** so that a commit touching k of n rows rewrites O(k·log n) nodes and a diff is a
structural comparison, not an O(n) scan. We adopt that (Decision 11) — it strengthens I4
without changing any higher-level concept.

---

## 2. Tooling, mapped to the slices

| Tool | Slice fit | Why | Caveat / nuance | Verdict |
|---|---|---|---|---|
| **IPLD + IPLD Schemas** (dag-cbor) | S0, S1, S4, S5 | CIDs-as-links are native; typed schemas resolve cross-document CIDs as graph edges → serves **I6/I7** directly | Our on-chain/ZK root is **Poseidon2**, *not* the IPLD CID hash (sha2/blake3). So every object carries **two** hashes: the IPLD **CID** (addressing/dedup/links) and the Poseidon2 **root** (verify/settlement). They coexist; don't conflate. | **Adopt IPLD dag-cbor** as the object codec; keep Poseidon2 as the committed root. Revises S0. |
| **Iroh** (Rust IPFS) | S1 CLI, S2/S7 indexer | Fast blobs + docs, embeddable, skips Kubo overhead — ideal for a diffing engine | SDK is **TypeScript**, quickbeam is **Python**. Iroh is Rust. Payoff only if we stand up a **Rust core** — and `fangorn-rs/` already exists in the workspace. | **Evaluate** a Rust `fangorn-core` (Prolly-tree + Iroh) with TS/Py bindings — Decision 13. Not day-one. |
| **LeanIMT / Semaphore tree primitives** | S3, S6, AC0 | Audited incremental Merkle tree, Poseidon-hashed, Semaphore-compatible depth/hashing | **Do not use it for the dataset Tree.** LeanIMT is an *append/update incremental* tree for **membership sets**, not a random-access map for millions of mutable rows (that's the Prolly tree). | **Adopt LeanIMT for the *membership/registry* trees** — writer groups, the registered-gadget set — so Phase 4 Semaphore is compatible out of the gate. **Reject** it as the dataset Tree. |
| **Lit Protocol** | AC2 (read gate) | Decentralized threshold/TEE network with boolean access-control conditions + conditional decryption — a ready-made "decrypt iff predicate" network | Its predicate surface is **Lit Actions (JS) / access-control conditions**, not our **Noir gadget chains**. Using Lit = *buy the network, express predicates their way*; keeping our worker/TEE = *build the network, keep ZK gadgets*. | **Genuine build-vs-buy fork** → Decision 15. Strong candidate to *replace* the custom worker/TEE for AC2; the gadget chain then becomes a Lit condition, with ZK gadgets reserved for the on-chain **write** gate. |
| **RISC Zero / Bonsai** (zkVM) | AC3, S6 (write gate) | Write complex predicate logic in **Rust**, prove off-chain (Bonsai), verify on-chain at `update_ref` | Heavier proofs than a hand-tuned Noir gadget for *simple* predicates; the `gadgets` repo is already Noir | **Adopt selectively**: Noir gadgets for the common, cheap predicates (payment/ecdsa/membership); zkVM for the long-tail "arbitrary logic" gadget — Decision 16. |
| **Substreams** (StreamingFast) | S2, S7 (trigger) | Parallelized, Rust-based EVM extraction of `RefUpdated` → into an indexer → parallel tree-diffs → Qdrant | quickbeam is **Python**; Substreams sinks over gRPC (Rust-native, Python-consumable). Replaces the 60s subgraph poll (`watcher.py`). | **Adopt** as the `RefUpdated` transport, superseding the poll. Pairs with the Rust-core evaluation (Decision 13). |

---

## 3. New & refined decisions this scan forces

Appended to the master's §8. The first is the important one.

| # | Decision | Prior art | Recommendation |
|---|---|---|---|
| **11** | **What the Tree object is** — flat `LeafRef` list vs. a **Prolly tree / Merkle-search tree** (paged, content-defined, history-independent) | Dolt, LakeFS | **Prolly tree.** Log-scale diff + deterministic root + 3-way merge (which S4 view-merges want anyway). Biggest single borrow. |
| **12** | **Object codec** — hand-rolled JSON envelopes vs **IPLD dag-cbor + IPLD Schema** | IPLD, Qri, Ceramic | **IPLD dag-cbor**, Poseidon2 root carried alongside the CID (dual-hash, §2). Revises S0. |
| **13** | **Core language** — keep TS(SDK)/Py(quickbeam) vs a **Rust `fangorn-core`** (Prolly + Iroh) with bindings | Iroh, Dolt(Noms), Radicle(Heartwood) | Prototype the Prolly-tree + diff engine in **Rust** in `fangorn-rs/`; expose via WASM/native bindings. De-risk in Phase 1; commit if diff perf demands it. |
| **14** | **Push anchoring** — one tx per `push` vs **batched anchor** of many ref updates | Ceramic anchors | Start one-tx-per-push (simple, S3). Add optional **batched anchoring** (merkle of many tips, one tx) as a gas-amortization slice when volume warrants. |
| **15** | **Read-gate: build vs buy** — custom worker/TEE vs **Lit Protocol** network | Lit | Buy the network (Lit) for AC2 read decryption; keep **ZK gadget chains for the on-chain write gate**. Predicate expressed twice (Lit condition for read, Noir/zkVM for write) — accept the duplication or unify later. |
| **16** | **Proving stack** — Noir gadgets only vs **Noir + RISC Zero zkVM** | RISC Zero/Bonsai | Hybrid: Noir for cheap common gadgets, zkVM for arbitrary-logic gadgets. Keep the gadget-registry interface stack-agnostic. |

### Reinforced (already in the master, now with precedent)

- **Decision 4 (read-gate verifier location) → TEE-first, then hybrid.** On-chain ZK
  verification per read is economically restrictive; the standard pattern is a
  threshold/TEE network checking on-chain state and releasing a decryption key with
  attestation. **Lit Protocol** (Decision 15) is the concrete off-the-shelf instance.
- **Decision 10 (re-price path) → empty-diff commit.** Model a price change exactly like
  `git commit --allow-empty` / a git tag: it lands on the timeline, so quickbeam stays
  cleanly bound to the commit stream with no separate pricing-poll side channel.

---

## 4. What this changes in the plan (deltas, not rewrites)

- **S0** now specifies **IPLD dag-cbor + IPLD Schema** for object encoding, dual-hashed
  with Poseidon2 (Decisions 11–12), and the **Tree is a Prolly tree** whose golden
  fixture must round-trip identically in TS and Python (and Rust, if Decision 13 lands).
- **S2/S7** trigger transport becomes **Substreams** over the subgraph poll; the tree-diff
  is a Prolly-tree structural diff (cheap by construction).
- **S3/S6** membership/registry trees use **LeanIMT** for Semaphore compatibility;
  **anchoring** (Decision 14) is a later gas slice.
- **AC2** is re-scoped as a **Lit Protocol integration** (build-vs-buy, Decision 15)
  rather than a from-scratch worker/TEE network; **AC3** write-gate proofs may use
  **RISC Zero** for complex gadgets (Decision 16).
- **Cross-cutting:** a `fangorn-rs/` **Prolly-tree + diff core** spike (Decision 13) runs
  alongside Phase 1 to de-risk the one component (the Tree) that every slice leans on.

None of these change the *model* (invariants I1–I9, the five planes, the merged roadmap).
They change the *substrate choices* underneath it — which is exactly what a prior-art pass
should do.
```
