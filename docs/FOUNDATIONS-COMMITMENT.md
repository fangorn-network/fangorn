# Foundations of Fangorn, v0.2 — The Commitment Theorem

*The load-bearing thread, made rigorous. This memo collapses the broad v0.1 map
(`FOUNDATIONS.md`) onto a single spine: the claim that **canonicalization, a
history-independent physical layout, and a representation-independent cryptographic
commitment are one fact viewed three ways** — and that this fact is exactly what
Fangorn's identity system makes computable. Everything not serving that spine is a
one-line pointer; off-thread corrections from the three-specialist review are
banked in §10 for the next memo.*

*Incorporates round-2 review by three researchers (category theory, cryptography,
systems). Where they overturned v0.1, the correction is stated as such. Labels:
**DEFINITION / THEOREM(sketch) / DESIGN-LAW / OPEN**.*

---

## 1. Why this is the thread that matters

Publication, verification, incremental sync, structural sharing, and on-chain
settlement **all** bottom out on one question: *what bytes do we commit, and what
do they bind?* If the commitment binds to presentation (byte order, chunk
boundaries, insertion history) then two identical datasets get different roots,
diffs churn, sync is O(n), and "verify this is the published knowledge" is a claim
about a serialization, not about knowledge. If it binds to the *knowledge*, all of
those become cheap and correct at once. So we make that one thing rigorous first.

The three-way coincidence, informally:

- **Semantics (canon):** every dataset has a unique canonical form; equal meaning ⇒
  equal canonical bytes.
- **Systems (history-independence):** the physical tree's shape depends only on
  content, never on the order rows arrived — so a 1-row insert touches O(log n)
  nodes, not all of them.
- **Crypto (binding):** the root binds the knowledge up to the equivalence canon
  quotients by, and nothing finer.

v0.1 asserted these coincide (Observation 1). v0.2 proves it — but only after
fixing *which* equivalence, because the naïve choice is not computable.

---

## 2. The object, corrected: attributed C-sets over a keyed sketch

**Round-2 correction (category theory).** v0.1 anchored on Schultz–Spivak–Wisnesky
*algebraic databases* with an attribute profunctor. That is heavier than we use and
its "instance morphism = natural transformation" is **too loose** — it would let
renaming a value count as a knowledge-isomorphism. The sharper, implementation-
matching object:

**DEFINITION 1 (Schema).** A **schema** 𝒮 is a finite **sketch** (a small category
of entity types and foreign-key morphisms, *plus* declared cardinality/uniqueness
cones) together with a set of **attributes** into a fixed type side **Ty** (the
value domains: string, number, bytes, geo, …). The sketch — not a bare category —
is what carries the `min/max` edge constraints and key-uniqueness that the bundle
schemas already use.

**DEFINITION 2 (Instance = attributed C-set).** A dataset is an **attributed
C-set** (ACSet, in the sense of Patterson–Lynch–Fairbanks / Catlab): a finite set
of rows per entity type, functions realizing the foreign keys, and typed attribute
values, satisfying 𝒮's cones. Instance morphisms are ACSet homomorphisms that
**fix the type side** (identity on value domains). Instances form **Inst(𝒮)**.

**Convergence A (mathematician's object = builder's data structure).** An ACSet
*is* a columnar store: one integer-keyed column per attribute, CSR/adjacency per
foreign key. The category theorist's chosen object and the builder's "the only rep
that survives 10⁹ nodes is streamed dictionary-encoded Arrow / C-set" are the same
structure. There is no translation tax between the math and the storage — the IR
and the on-disk form are one thing. (This is why the v0.1 sketch
`SemanticIR{ nodes: IRNode[] }` was wrong: an array-of-structs OOMs at ~300 GB for
10⁹ nodes; the ACSet/columnar form is the fix, not a different design.)

---

## 3. The invariant, corrected: the identity-keyed class `[I]_key`

**Round-2 correction (cryptography), the deepest one.** v0.1 Definition 3 said
knowledge = the full isomorphism class `[I]`. That is **not computable to a
canonical form**: choosing one representative per full iso-class is *graph
canonical labelling*, which is graph-isomorphism-hard whenever identity is
relational (an entity is identified by its links, not a key). You cannot commit to
an object whose canonical form you cannot compute.

The fix is already in Fangorn, and it is why the identity layer exists.

**DEFINITION 3′ (Identity key / rigidification).** 𝒮 carries an **identity key**:
a designated subfunctor `key : Inst(𝒮) → Inst(𝒮_id)` assigning each entity a
globally unique name — Fangorn's **Entity URI** `fangorn:<repo>/<localId>` and its
**alias namespaces** (`gplace:`, `isrc:`). A **key-fixing isomorphism** is an
instance iso that fixes the type side *and* commutes with `key`. The **rigidified
class** `[I]_key` is `I` modulo key-fixing isos.

**LEMMA 1 (rigidity).** *If `key` is monic on entities (each entity has a unique
identity value — the Entity URI is constructed to guarantee this), then the only
key-fixing automorphism of `I` is the identity: `I` is **rigid**, so `[I]_key` has
a unique labelling — the one induced by sorting on `key`.* Sketch: a key-fixing
automorphism must send each entity to one with the same key; monicity of `key`
forces it to be the identity on entities, hence (fixing the type side) on
attributes and edges.

**THEOREM 1 (canon is polynomial for keyed schemas).** *For a schema with a monic
identity key, there is an O(n log n + E) canonicalizer `canon : Inst(𝒮) →
Inst(𝒮)` selecting the key-sorted representative of `[I]_key`: sort entities by
Entity URI, emit attributes in a fixed column order, emit each foreign key as the
sorted target's rank. No isomorphism search occurs — the key breaks all symmetry.*
Contrast: drop the key and this reduces to graph canonical labelling (GI-hard). **The
identity system is precisely the structure that moves canonicalization from
intractable to a sort.**

**DEFINITION 4 (Canonicalization = reflective skeleton).** `canon` is idempotent
(`canon∘canon = canon`) and picks one on-the-nose representative per `[I]_key` — the
reflector onto the skeleton of rigidified classes (an idempotent monad whose
algebras are already-canonical instances). "Knowledge," for commitment purposes, is
`[I]_key`; JSON/RDF/SQL renderings are faithful functors out of it, all landing on
the same `canon(I)`.

**(Retained from v0.1, defended in review:)** on finite instances, iso coincides
with elementary equivalence, so `[I]_key` is also the right *logical* invariant;
bisimulation would be too coarse.

**OPEN 3a (weak identity).** When a schema has only a *partial* or *non-monic* key
(some entities identified relationally), rigidity fails and canon reinherits a
bounded GI-hard core over just those entities. Scope: quantify the residual and
whether a secondary structural key (canonical hashing of the local neighbourhood,
à la colour refinement / Weisfeiler–Leman) rigidifies it in practice.

---

## 4. The Commitment Theorem

**DESIGN-LAW B (semantic binding, defended in review).** The commitment factors
through canon: `Cmt = Cmt₀ ∘ canon`. We now state precisely what it buys, and —
the key cryptographic refinement — **which half is unconditional**.

**DEFINITION 5 (binding up to `[I]_key`).** `Cmt` is *binding up to `[I]_key`* if
it is infeasible to exhibit `I, J` with `[I]_key ≠ [J]_key` yet `Cmt(I) = Cmt(J)`.

**THEOREM 2 (the three-legged coincidence).** *For a keyed schema (Thm 1), with
`Cmt₀ =` a Merkle commitment over a content-defined (prolly) layout of `canon(I)`'s
leaves using hash `H`:*

1. **(Semantics — UNCONDITIONAL.)** `canon` is complete:
   `⟦I⟧ = ⟦J⟧ ⇒ canon(I) = canon(J)` as byte strings. *(Thm 1; no assumption.)*
2. **(Systems — UNCONDITIONAL.)** The layout is history-independent: the prolly
   tree's shape and root are a function of `canon(I)` alone, not of insertion
   order. *(Content-defined chunk boundaries depend only on content; the tree is
   probabilistic in chunk **size** but the **root is deterministic** given
   canonical content — round-2 builder verdict, correcting the reviewer's own
   "probabilistic ⇒ non-exact" worry.)*
3. **(Crypto — CONDITIONAL on `H` only.)** `Cmt` is binding up to `[I]_key`, and
   the reduction is tight: a binding break is exactly an `H`-collision.

*Proof of leg 3 (sketch).* `canon` is a bijection from rigidified classes to
canonical byte strings (Thm 1 + Def 4). If `[I]_key ≠ [J]_key` then
`canon(I) ≠ canon(J)` as strings; leg 2 makes `layout` a deterministic function of
those strings; a Merkle root collision on distinct leaf strings yields an
`H`-collision by the standard tree-collision extractor. ∎

**Reading of the theorem (the payoff).** *Representation-independence* — the
property that makes verification meaningful — is leg 1 ∧ leg 2, **both
unconditional**. The cryptographic assumption (`H` collision-resistance; here the
young, heuristic Poseidon2) is confined to leg 3, and only to the *residual*
hardness of forging a collision — **not** to representation-independence. v0.1
spoke of "binding" as one cryptographic obligation; it is really two, and the
load-bearing half is a theorem about an algorithm, not an assumption. This both
strengthens the guarantee and reduces the reliance on Poseidon2's immaturity.

**Observation 1, now settled.** History-independence ⟺ `canon` well-defined ⟺
representation-independent binding: all three are the single statement
"`layout ∘ canon` depends only on `[I]_key`," which holds unconditionally for keyed
schemas (legs 1–2). The three research communities' requirements are one
requirement. *This is the memo's central result.*

---

## 5. When a pass is safe: `canon ∘ P = canon`

**Round-2 correction (category theory).** v0.1 said a semantics-preserving pass is
an endofunctor with a natural iso `P ⟹ Id`. The right object is the *denotation
square*: the natural iso is `⟦−⟧ ∘ P ≅ ⟦−⟧`, not `P ≅ Id`. Specialized through
`Cmt = Cmt₀ ∘ canon`, this becomes a test you can run in code:

**DESIGN-LAW C (commitment-preserving pass).** A pass `P` preserves the commitment
**iff `canon(P(I)) = canon(I)` for all `I`.** Structural sharing, reordering, and
byte-level dedup satisfy this; they only move presentation within `[I]_key`.

**Round-2 correction (both reviewers): "dedup" is two passes, not one.**
- *Byte-sharing* (reuse an identical chunk): `canon`-invariant ⇒ commitment-
  preserving. Safe on the trusted path.
- *Record-collapse* (merge two rows asserted equal): this **changes `[I]_key`** — it
  is a quotient (an epimorphism), i.e. a *meaning-changing* pass belonging to the
  fusion/reasoning tier, **not** the commitment-preserving tier. Conflating the two
  is how an "optimization" can silently alter what was committed. Keep them in
  different tiers.

---

## 6. The gap: today's commitment realizes none of the three legs

**Round-2 correction (systems), grounding the theory in the actual code.** The
current commitment is **not** the tree Theorem 2 describes:

- Leaves hash `poseidon2([index, hashString(cid)])` — **position + storage
  address**, not canonical content (`buildManifest`, `src/roles/publisher/index.ts:300-302`).
- Chunk boundaries are **count-based** (1000 records, ordered by a monotonic yield
  `seq`; `src/roles/publisher/builders/bundle.ts:103`) — **history-dependent**.
- Consequence: insert one entity at the front → every chunk reshuffles → every CID
  moves → the root moves → `diffManifests` (`src/objects/store.ts`) churns **O(n)**,
  not O(k).

| Leg of Thm 2 | Requires | Current code | Change |
|---|---|---|---|
| 1 · canon | key-sorted canonical instance | none (yield order preserved) | canonicalize the ACSet on Entity URI before layout |
| 2 · history-independence | content-defined (prolly) chunking | count-based `chunkSize` | prolly boundaries over canonical bytes |
| 3 · binding | leaves hash **content** | leaves hash `(index, cid)` | leaf = `H(canonical content)` |

So the thread's engineering payload is one coherent change: **canonicalize →
content-define the layout → hash content.** It is not three features; it is the
three legs of one theorem.

---

## 7. Byte-stability: the honest verdict (correcting v0.1 §10)

**v0.1 §10 claimed you could insert `canon` while keeping the Poseidon2 root
byte-stable. That is false** (round-2 systems, confirmed against the code): `canon`
reorders leaves and re-hashes them on content instead of `(index, cid)`, so the
root *necessarily* changes. There is no transparent insertion.

**DESIGN-LAW D (versioned commitment, one-time re-root).** The commitment scheme is
named in the commit object (`commitment: "<backend-id>"`, per
`COMPILER_ARCHITECTURE.md` §4). Migrating to the Theorem-2 commitment is a
**coordinated slice**: a one-time re-root + reindex, with old roots verifiable under
the old backend id and new commits under the new one. Do not smuggle it under
"root unchanged." This is the single place the thread touches consensus-visible
state, so it gets its own migration, its own test vectors, and a golden fixture
before anything else moves.

---

## 8. The commitment backend menu, corrected

**Round-2 correction (cryptography): the accumulator-as-north-star was wrong.**

| Backend `Cmt₀` (all over `canon`) | Binds | Opening | Verdict |
|---|---|---|---|
| **Poseidon2 Merkle / prolly** | leaf multiset | O(log n), ZK-friendly | **ship** — the one we own; arithmetization-friendly for on-chain SNARK settlement |
| **KZG / Verkle over canon** | vector | O(1), aggregatable | **north star** (replaces "accumulator"): short openings + proof aggregation dominate accumulators for Fangorn's requirement set |
| **Multiset / Pedersen hash** | set, natively order-free | homomorphic | option when you want set-binding with *no* canon step (commits the set directly) |
| Bilinear/RSA accumulator | set | O(1) membership | **demoted** — trusted setup / awkward non-membership; not worth it here |

The seam (`CommitmentBackend`, `COMPILER_ARCHITECTURE.md` §4) is what must exist;
build only the first row now. Note the interplay with Def B: Merkle/prolly and
KZG/Verkle **need** the canon step (they bind order); a multiset/Pedersen hash is
the one row that binds a set *natively* and could in principle skip canon — a real
design fork worth keeping open (OPEN 8a).

---

## 9. The first slice (concrete, sequenced)

**Round-2 systems verdict: the prolly-canon swap is the true first-mover, not the
IR split.** Splitting `chunk()` around the IR behind a nicer interface, with
count-chunking still underneath, delivers *none* of the scaling wins — O(n)
rebuilds persist behind a prettier facade. But the swap *forces* the IR: you cannot
content-define a layout over a canonical instance you have not first materialized as
an ACSet. So they land together, in this order inside one slice:

1. **Materialize the ACSet / canonical instance** (Convergence A: columnar,
   streamed, dictionary-encoded — not `IRNode[]`). Canonicalize by Entity-URI sort.
2. **Content-defined (prolly) layout** over canonical bytes; leaf = `H(content)`.
3. **Poseidon2 over the prolly leaves**; register a new commitment-backend id
   (Design-Law D); write the golden re-root fixture.
4. The `chunk()` fusion untangles as a consequence — identity-stamping moves into
   step 1 (it *is* the `key` functor), storage-partitioning into step 2.

**Metrics to hit (round-2 estimates):** k = 1000 changed of n = 10⁶ leaves →
~10⁴ dirty nodes → ~320 KB proof, sub-second recommit; versus today's full rebuild
≈ 20–90 s/commit. Diff complexity O(k · log(n/k)), verified for a fixed-fanout
prolly tree. Memory bounded by streaming (peak ≈ one chunk), so 10⁹ nodes is an
on-disk, not in-RAM, problem.

**Watch-out (round-2 systems):** the current cross-chunk graph validation keeps an
in-RAM node-id map (`bundle.ts`); step 1 inherits it. Either stream validation
against the sorted key column or accept a bounded memory floor. Track as a subtask,
not a blocker.

---

## 10. Banked for the next memo (off-thread corrections, not lost)

These round-2 findings are real and belong to fusion/access/sync, not the
commitment thread. Recorded so v0.3 starts from them:

- **Fusion is a coequalizer over var-ACSets, not a pushout (category theory).** On
  *attribute conflict* the plain `Inst(𝒮)` colimit **does not exist** — you must
  move to ACSets-with-variables. A view must commit over the var-ACSet fusion, and
  the "recovery" theorem in v0.1 §6 is **backwards**: tightening trust yields an
  **epimorphism/quotient** `colim_τ' ↠ colim_τ`, not a subobject mono; recovery is
  *refusing a merge*, not *taking a sub-object*. (Explicit counterexample in the
  round-2 category note.)
- **Fusion + conflict + CRDT are one event (all three reviewers).** The attribute
  conflict that makes the pushout not exist **is** the sheaf gluing obstruction
  **is** where a semilattice join is needed. Build one *coequalizer-with-unification*
  seam, not three subsystems. Also: it's a **presheaf**, not a sheaf (the sheaf
  axioms are the *diagnostic* for conflict); conflict *detection* is a cheap
  equalizer/matching-family check, so v0.1's O4 ("is cohomology computable?") is a
  non-problem — cohomology only says anything for lattice-valued attributes.
- **The read/write "duality" is decorative (cryptography).** "Proof ⊣ encryption"
  has no functors and no natural iso — downgrade it to a witness-role symmetry
  unified by **predicate encryption**, with the one real reduction being WE ⇒ NIZK.
  The genuine dual pair is the **reasoning monad `R`** vs the **visibility comonad
  `Vis_c`** (v0.1 §8) — don't let the fake duality lean on the real one.
- **Access is a trust × expressiveness grid, not a ladder (cryptography).** The seal
  model needs **CP-ABE** (Waters/pairings), not KP-ABE; the missing middle rung is
  bounded-circuit ABE/PE from LWE (pre-production). Critically: **"payment settled"
  is stateful, so it provably cannot be WE/ABE** (stateless ⇒ no replay/revocation)
  — it is forced onto a committee/contract release keyed on the settlement nullifier
  (today's Lit + x402/ERC-3009 stack). The decision rule for the whole grid: *can
  the verifier recompute, and does the predicate reference mutable state?*
- **Reasoning default is recompute-and-compare, not a SNARK (cryptography).**
  Deterministic `R` is canonicalizable, so consumers recompute and compare roots
  (unconditional); a SNARK over the chase is warranted only for *sealed* inputs or
  thin verifiers. Matches Design-Law C's tiering.
- **Embeddings (cryptography):** no binding of semantic distance (retained), but
  zkML verifiable-provenance (small models) and PIR/private-ANN are worth having —
  strictly off the settlement path.

---

## 11. What v0.2 establishes, in one paragraph

For any schema with a monic identity key — which Fangorn guarantees via Entity URIs
and alias namespaces — canonicalization is an O(n log n) sort (not GI-hard),
history-independent prolly layout over the canonical form is a *function of the
knowledge alone*, and a Poseidon2 root over that layout binds the knowledge up to
`[I]_key` with the binding reducing exactly to hash collision-resistance —
while representation-independence itself needs *no* cryptographic assumption. The
current SDK realizes none of the three legs (it hashes position + address with
count-based chunking), so the highest-leverage first change is a single coordinated
slice — canonical ACSet → content-defined layout → content-hashed Poseidon2 leaves —
which is root-breaking and therefore a versioned one-time migration, and which
delivers history-independence, O(k·log(n/k)) verifiable diffs, and insert-surviving
structural sharing together, because they were always the same theorem.
