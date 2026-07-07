# Foundations of Fangorn — A Mathematical Model for Machine-Native Knowledge

*Research memo, v0.1 (the broad map). This is the opening of a long-term program,
not a spec and not a defense of the current SDK. We reason from first principles
and let the implementation move toward the mathematics.*

> **ERRATA / SUPERSEDED — read `FOUNDATIONS-COMMITMENT.md` (v0.2) for the corrected
> load-bearing thread.** After a three-specialist review, two claims below are
> **wrong** and are fixed in v0.2: (1) **§1 Definition 3** — the invariant is *not*
> the full isomorphism class `[I]`; committing to that is graph-isomorphism-hard.
> It is the **identity-keyed (rigidified) class `[I]_key`**, made polynomial by
> Fangorn's Entity-URI/alias key. (2) **§10** — "insert `canon`, keep the Poseidon2
> root byte-stable" is **false**; canon necessarily changes the root, so it is a
> coordinated one-time re-root migration, not a transparent insertion. v0.1 remains
> as the broad map; v0.2 is the rigorous thread. Off-thread §6–§9 corrections are
> banked at the end of v0.2 for a later memo.*

*Method: four voices in continuous debate — **M** (the Mathematician, Tao-ish:
definitions first, borrow don't invent), **C** (the Cryptographer, Garg/Boneh-ish:
what is committed, what is proven, under what assumption), **K** (the Compiler
architect: parsing, IR, passes, targets, correctness), **B** (the Builder:
can it scale to 10⁹ nodes, sync incrementally, and migrate from today's SDK).
Disagreement is kept, not smoothed. Adopted claims are labelled
**DEFINITION / THEOREM (sketch) / CONJECTURE / DESIGN-LAW / OPEN**.*

---

## 0. The central question, stated precisely

> What is the object that every faithful representation of a piece of machine
> knowledge preserves — the thing that is invariant when the same knowledge is
> written as JSON, RDF, a property graph, a SQL export, or a tensor?

We want the invariant, then let representations, compilation, commitment, fusion,
sync, and access **emerge** from its structure.

**B (opening skepticism):** Before any category shows up — the invariant has to be
*computable* and *serializable to canonical bytes*, or none of publication,
commitment, or sync can exist. An "invariant up to isomorphism" that has no
canonical representative is useless to me. Hold that thought; I will collect on it.

---

## 1. The semantic object

### 1.1 First-principles candidates

**M:** Four honest candidates for "a piece of knowledge," from the literature:

1. **A logical structure (model theory).** Fix a signature σ (sorts, typed
   relations, functions). A dataset is a finite σ-structure *A* = (domain,
   interpretations). "Same knowledge" = isomorphism of structures. Reasoning =
   entailment ⊨. This is the classical Knowledge-Representation view; RDF is the
   special case σ = one ternary relation `triple(s,p,o)`; relational databases are
   finite structures; Description Logics are decidable fragments of first-order
   logic over exactly these structures.

2. **A functor / copresheaf (functorial data migration, Spivak).** A schema is a
   small category (or sketch) **𝒮**; a dataset is a functor **I : 𝒮 → Set** (a
   copresheaf). This is the same content as (1) organized so that *schema
   morphisms* F : 𝒮 → 𝒯 induce *data-migration* functors — the adjoint triple
   Σ_F ⊣ Δ_F ⊣ Π_F (left Kan extension ⊣ pullback ⊣ right Kan extension).

3. **A typed labelled multigraph / hypergraph.** Nodes, typed edges, attributes.
   Operationally what PROTOCOL.md describes.

4. **A sheaf on a site of contexts.** Knowledge as *local sections that glue*.
   (We return to this in §7 — it is the right frame for *fusion and sync*, but
   overkill for defining a single dataset.)

**M:** (3) is a *presentation* of (1)/(2), not a competitor — a multigraph is a
structure over the signature {node, edge, src, tgt, label}. So the real fork is
**model theory (1) vs. functorial (2)**. They describe the same objects; they
differ in what comes for free.

- Model theory gives **logic for free**: constraints, entailment, the chase,
  decidable reasoning fragments. It is weak on *transformation algebra*.
- The functorial view gives **transformation for free**: schema evolution and
  joins are (co)limits and Kan extensions — exactly a compiler's data-migration
  passes — but bare `𝒮 → Set` has no place for *attribute values* (a `name`
  string, a `location`), and its native notion of equality is object identity.

**K:** For a compiler I need both: a typed IR I can *migrate* (functorial) and a
*type system with value-level constraints* (logical). The clean reconciliation
already exists in the literature.

### 1.2 Adopted object: an instance of an algebraic schema

**DEFINITION 1 (Schema).** A **schema** is a small category **𝒮** (entity types
as objects, foreign-key-like relationships as morphisms) together with a set of
*attribute maps* into a fixed **type side** — a multi-sorted algebraic theory
**Ty** whose models are the value domains (strings, numbers, bytes, geo, …). This
is precisely the **algebraic database** of Schultz–Spivak–Wisnesky (2017): the
combination of a category (for entities/relationships) and an algebraic theory
(for data values), linked by a profunctor.

**DEFINITION 2 (Semantic object / instance).** A **dataset** over 𝒮 is an
instance **I** of that algebraic schema: a functor assigning a finite set of rows
to each entity type, an action to each relationship, and typed values to each
attribute, subject to 𝒮's equations (path equalities = referential/typing
constraints). The instances of 𝒮 form a category **Inst(𝒮)** (morphisms =
natural transformations = schema-respecting mappings of rows).

**DEFINITION 3 (The invariant).** The **knowledge** carried by a dataset is its
**isomorphism class** [I] in Inst(𝒮). *This is the object §0 asked for.* JSON,
RDF, property-graph, SQL, tensor renderings are all **faithful functors out of
Inst(𝒮)** into representation categories; each forgets presentation detail
(key order, chunking, row order) but preserves [I].

**Why this and not bare model theory:** it keeps the logic (constraints are
equations/lifting conditions in 𝒮; reasoning fragments are the DL sublanguages)
**and** gets the migration algebra (Σ/Δ/Π) that the compiler needs — one object,
both affordances. **Why not bare graphs:** "graph" under-specifies typing and
loses the adjoint migrations. We connect to graphs by noting Inst(𝒮) for the
one-object multigraph schema *is* labelled multigraphs — graphs are the special
case, not the foundation.

**Literature anchors:** Spivak, *Functorial Data Migration*; Schultz, Spivak,
Wisnesky, *Algebraic Databases*; Fong & Spivak, *Seven Sketches* (for the applied
framing); classical finite model theory (Libkin) for the logic side; C-sets /
copresheaves as the implementation-friendly restriction.

**C (first intervention):** I can commit to [I] only if it has a *canonical
representative*. An isomorphism class is not bytes. Whatever you commit must be
invariant under exactly the isos you quotiented by — otherwise the commitment
binds to presentation, not knowledge. Park this; it forces §3 and §5.

**B:** And Inst(𝒮) morphisms as "natural transformations" must be checkable in
near-linear time or 10⁹-node fusion is dead. Park that for §6–§7.

---

## 2. Representations and faithfulness

**DEFINITION 4 (Representation category, frontend).** For each concrete syntax
let **Rep_X** be its category (objects: JSON docs / RDF graphs / property graphs /
Arrow tables / vectors; morphisms: syntax-preserving maps). A **frontend** is a
functor **F_X : Rep_X → Inst(𝒮)** ("parse + type"). Its partial inverse (the
**backend/serializer**) **G_X : Inst(𝒮) → Rep_X** renders.

**DEFINITION 5 (Faithful representation).** X is **faithful** for 𝒮 if
F_X ∘ G_X ≅ id on Inst(𝒮): rendering then re-parsing recovers the instance up to
iso. Faithfulness is *relative to a schema* — JSON is faithful for most 𝒮,
tensors/embeddings are **not** (they are lossy; §9).

**K:** This is the compiler's front matter exactly: many frontends, one IR
(Inst(𝒮)), pluggable backends. The denotation map ⟦−⟧ = the quotient
Inst(𝒮) → Inst(𝒮)/≅. A frontend is *semantics-computing* when ⟦F_X(r)⟧ depends
only on the meaning of r, not its byte layout.

**M:** Note what we did *not* do: we did not privilege JSON. JSON is one Rep_X
with a faithful frontend. RDF is another. The protocol's mistake — schemas *being*
JSON schemas — is now visibly a category error: it conflates 𝒮 (the schema, a
category) with G_JSON(schema) (its JSON rendering).

---

## 3. Canonical form, and why it is forced

**C's debt from §1 comes due.** To commit or content-address knowledge we need a
*section* of the quotient ⟦−⟧ : Inst(𝒮) → Inst(𝒮)/≅ — one canonical instance per
iso class.

**DEFINITION 6 (Canonicalization).** A **canonicalizer** is an idempotent functor
**canon : Inst(𝒮) → Inst(𝒮)** with canon(I) ≅ I and (I ≅ J ⟹ canon(I) =
canon(J)) *on the nose* (equal, not merely iso). Equivalently, canon picks a
**skeleton** of Inst(𝒮): a normal form. It is the reflector of the reflective
subcategory of canonical instances — an idempotent monad whose algebras are
"already-canonical" datasets.

**M:** Canonicalization is not an implementation nicety; it is the *choice of
representatives* that turns the invariant [I] into a manipulable object. In
compiler terms it is normalization to a normal form; in rewriting terms it is
confluence + termination giving unique normal forms.

**B (collecting on §0):** Here is the payoff I promised to demand. A
**history-independent data structure** is precisely one whose physical layout is a
function of its *content* (the set), not its insertion order — i.e. it *is* a
canonicalizer realized as a data structure. **Prolly trees** (probabilistic
B-trees, content-defined chunking; Dolt/Noms) are history-independent. So:

**THEOREM-SHAPED OBSERVATION 1.** *History-independence (a systems property) =
representation-independence of the commitment (a semantic property) = canon being
well-defined (a categorical property).* The three communities' requirements
coincide. This is why prolly trees are not an arbitrary engineering pick — they
are the data-structure incarnation of Definition 6.

**K:** Therefore the **Semantic IR is Inst(𝒮) itself** — the canonical instance —
and "lowering to storage" is `G_prolly : Inst(𝒮) → Rep_prolly`. That is the honest
analogue of LLVM IR: a typed, representation-independent object that all frontends
target and all backends consume.

**DESIGN-LAW A.** Every commitment and every content-address is computed on
`canon(I)`, never on a raw frontend rendering. (This is COMPILER_ARCHITECTURE's
"commit semantic objects, not JSON," now with a definition behind it.)

---

## 4. Passes, reasoning, and correctness

**DEFINITION 7 (Optimization pass).** A **semantics-preserving pass** is an
endofunctor **T : Inst(𝒮) → Inst(𝒮)** equipped with a natural isomorphism
**η : T ⟹ Id**. "⟦T(x)⟧ = ⟦x⟧" is exactly "η is a natural iso." Passes compose;
they form a monoid acting on Inst(𝒮) through natural isos — a checkable,
mechanizable statement (you verify η componentwise on a test instance, or prove it
once schematically). Chunking, dedup, structural sharing, reordering are all of
this kind: they change the *rendering*, never the class.

**M:** But some transformations *should* change meaning — inference. Computing the
deductive closure (materializing entailed edges; the database **chase**;
Datalog/OWL-RL saturation) is not iso-to-identity. It is a **monad**.

**DEFINITION 8 (Reasoning monad).** A reasoning discipline is an idempotent monad
**R : Inst(𝒮) → Inst(𝒮)** (a closure operator: I ⊆ R(I), R∘R = R, monotone). Its
algebras are the *saturated* / deductively-closed instances. The chase, transitive
closure of `sameAs`, and RDFS/OWL-RL materialization are instances of R.

**THEOREM (sketch) — the two-tier correctness law.** *A pipeline
Frontend → passes → Backend is correct iff every optimization pass carries a
natural iso to Id (Def 7) and every reasoning step is an R-algebra map (Def 8).
Then ⟦output⟧ = R(⟦input⟧): the meaning is preserved exactly up to the intended
closure.* Sketch: passes commute with ⟦−⟧ by naturality; R is the unique closure
requested; composition of a natural-iso family with a monad map is a monad map.

**K:** This gives the compiler a real correctness theorem, not a slogan: separate
the **meaning-preserving** passes (must be iso-to-id) from the **meaning-adding**
passes (must be R-algebra maps), and the pipeline's soundness is compositional.

**C:** Two tiers → two cryptographic obligations later: meaning-preserving passes
must preserve the *commitment* (§5); meaning-adding passes must be *proven*
(a verifier must check R was applied honestly — a SNARK over the chase step). Note
which is which; do not prove what you can make canonical.

---

## 5. Commitments — semantic, not byte

**C (lead).** What is being committed? Not a byte string — the class [I]. So:

**DESIGN-LAW B (semantic binding).** The commitment functor **Cmt : Inst(𝒮) →
𝗖𝗺𝘁** must satisfy Cmt = Cmt₀ ∘ canon: it factors through canonicalization. Then
⟦I⟧ = ⟦J⟧ ⟹ Cmt(I) = Cmt(J) (representation-independence) and, for binding, the
converse hardness: infeasible to find I ≇ J with Cmt(I) = Cmt(J) (collision =
break). A plain Merkle tree over a serialization **violates** this — it binds to
leaf order, i.e. to presentation. Merkle-over-`canon` does not.

**C:** The realizable menu, with the tradeoff stated:

| Commitment target 𝗖𝗺𝘁 | Binds | Proof size | Cost | When |
|---|---|---|---|---|
| Merkle over canonical (prolly) leaves | multiset of leaves | O(log n) | cheapest, ZK-friendly with Poseidon2 | default; the one we own |
| Vector / KZG commitment | ordered vector | O(1) | pairing setup; homomorphic | positional openings, aggregation |
| Bilinear/RSA **accumulator** | a **set**, natively order-free | O(1) membership | trusted setup / class groups | when you want set-semantics with no canon step |
| Verkle | vector, short paths | O(1)-ish | newer | large fan-out trees |

**M:** The accumulator is theoretically the *most honest* target — it commits to a
**set**, which is already representation-independent, so it needs no canon. But
Boneh-voice caution:

**C (Boneh voice):** accumulators buy order-independence at the price of a trusted
setup or class-group assumptions and awkward non-membership. For a system that
must settle **on-chain in a SNARK**, an arithmetization-friendly hash (Poseidon2)
over a canonical prolly layout is the pragmatic sweet spot: you pay one canon
pass, you get a small ZK-checkable root, no exotic setup. **Keep the accumulator
as the theoretical north star and a possible backend; ship Merkle-over-canon.**

**DEFINITION 9 (Semantic commitment).** Cmt₀ = arithmetization-friendly Merkle
(Poseidon2) over `canon(I)`'s leaves; **𝗖𝗺𝘁 is a backend**, swappable to
accumulator/KZG/verkle behind Def B. Provenance/history: the commit DAG is a
**copresheaf on the poset of commits**, content-addressed — a functor to 𝗖𝗺𝘁 that
*preserves colimits*, so shared subobjects share commitments (structural sharing =
colimit reuse). This is the categorical content of authenticated data structures
(Merkle DAGs) + incremental verifiable computation.

**B:** Incrementality requirement made concrete: a commit touching k of n leaves
must re-commit in **O(k log(n/k))**, and produce a *verifiable diff* (an ADS
proof) so a downstream indexer re-embeds only the delta. Prolly trees give the
diff; Poseidon2 gives the verifiable root; the copresheaf gives the semantics.
These three must agree — and by Observation 1 they do.

---

## 6. Fusion as a trust-weighted colimit

**M.** Two publishers describing the same world share *identity handles* (aliases:
`gplace:`, `isrc:`). Fusion is gluing two instances along what they agree on.

**DEFINITION 10 (Fusion).** Given instances I_A, I_B and an **identification**
K with maps K → I_A, K → I_B (a **span**; K = the entities the aliases equate),
the fused knowledge is the **pushout** I_A +_K I_B in Inst(𝒮) (a colimit;
coequalizes the two images of K). Associativity/commutativity of fusion = the
usual colimit coherence, up to canonical iso.

**M:** This is exactly a colimit-of-a-diagram-of-datasources — the semantic-web
"one big graph" is the colimit of the diagram whose legs are alias spans.

**C + B (the identity-jacking objection, joined).** The over-merge / identity-
jacking bug (see project memory: anyone sharing an alias can poison an entity) is
now *legible*: the pushout is being taken along an **untrusted span**. Anyone can
publish a K claiming K → I_yours. A raw colimit trusts every span equally.

**DEFINITION 11 (Trusted / weighted fusion).** Fix a **trust presheaf**
τ : (publishers)ᵒᵖ → [0,1] (or a Boolean whitelist) for a given *view*. Admissible
spans are those whose apex K is attested by a publisher in τ's support. Fusion is
the colimit **in the slice / comma category over τ** — equivalently a **weighted
colimit enriched over the quantale ([0,1], ≥, ×)** (Lawvere's metric/fuzzy
enrichment), where a linkset's `confidence ∈ [0,1]` is the enrichment weight.
Hard whitelist = the Boolean quantale {0,1}; fuzzy trust = the unit-interval
quantale.

**M:** So the fix the security memo wants ("publisher whitelist") is not a patch —
it is *choosing the subcategory of admissible spans / the enrichment base*. A
**view** = a choice of diagram + trust weighting; its commitment (a merge commit)
pins the exact spans, so the fused colimit is **reproducible and attestable**. A
**linkset** = an explicitly published span (the fuzzy case, no shared alias).

**THEOREM (sketch).** *Fusion is functorial in the trust weighting: tightening τ
(fewer admissible spans) yields a canonical mono into the more permissive fusion;
the “clean” subgraph is a subobject of the “poisoned” one.* Hence recovery from a
poisoning attack = restricting τ and recomputing the colimit — no data loss, just
a different admissible diagram. (This matches the keylink/recovery fix in memory.)

**OPEN.** Confidence-weighted colimits over a quantale are well-defined, but their
*efficient* computation at 10⁹ nodes (B's demand) is unproven — see §10.

---

## 7. Locality, sheaves, and synchronization

**M.** Why sheaves at all? Because knowledge is **glued from local pieces**
(per-publisher, per-commit, per-access-context) and the central operations are
*restriction* and *gluing*.

**DEFINITION 12 (Knowledge sheaf).** Fix a **site** — a category of *contexts*
(scopes/publishers/access-worlds) with a Grothendieck topology saying when a
family of contexts *covers*. A **knowledge sheaf** F assigns to each context the
instances valid there, with restriction maps, such that sections agreeing on
overlaps glue **uniquely**. Fusion (§6) is the gluing; the sheaf condition is
"the glued global section exists and is unique."

**M:** The failures are now named by the theory:
- **Not separated** (two distinct globals restrict alike) ⟺ **identity-jacking**:
  distinct real entities collapse to one section. Trust (§6) restores separation.
- **Gluing obstruction** (locals that don't glue) ⟺ a **merge conflict**: two
  commits disagree on an overlapping entity. The obstruction is a Čech
  1-cocycle — a *cohomological* measure of inconsistency across the covering.

**B (sync, concretely).** Three-way merge of two histories over a common ancestor
= **pushout in Inst(𝒮)** when it exists. To *guarantee* convergence without human
conflict resolution, restrict states to a **join-semilattice** — then pushouts
always exist (= join), which is exactly a **CRDT** (Merkle-CRDT / state-based CRDT
over the prolly tree). Tradeoff, stated honestly:

- **General pushout** (git-style): expressive data model, but conflicts can fail
  to glue → need resolution policy.
- **Semilattice/CRDT**: conflict-free convergence guaranteed, but constrains the
  schema to monotone/lattice-valued attributes.

**DESIGN-LAW C.** Sync operates on canonical instances via ADS-verifiable diffs;
convergence class (mergeable-with-policy vs. CRDT-guaranteed) is a per-schema
*declaration*, because it is a real semantic tradeoff, not a default.

**Literature:** sheaves on sites (Mac Lane–Moerdijk); sheaf-theoretic data
integration & "contextuality" (Abramsky et al.); CRDTs (Shapiro et al.);
Merkle-CRDTs (IPFS); the chase/gluing overlap with §4's monad.

---

## 8. Conditional access — unified with publication

**This is the original Fangorn motivation and it must live *inside* the object,
not as a layer.** The four voices converge here surprisingly hard.

**M/C.** A policy is an **NP relation** R ⊆ X × W (statement × witness), i.e. a
language L_R = { x : ∃w. R(x,w) }. Fangorn's composability ("paid **and**
subscriber") = R closed under ∧, ∨ (monotone Boolean formulas over atomic
relations) — an **access structure**.

**DEFINITION 13 (Sealed section).** A **sealed field** is a section of the
knowledge sheaf (§7) over the site of **access contexts**, whose stalk at a reader
in context c is **non-empty iff the reader holds a witness w with R(x,w)**. Access
is therefore not bolted on — it is a *support condition on sections of the very
sheaf that defines the knowledge*. Revealed knowledge = a **subsheaf** cut out by
the policy.

**THEOREM-SHAPED UNIFICATION (the read/write duality).**
*The same relation R gives both gates, as the two canonical ways to “use” an NP
predicate:*

| | Object | Security | Fangorn use |
|---|---|---|---|
| **Write / authorize** | NIZK **proof** of ∃w. R(x,w) | soundness: cannot act without a witness; zero-knowledge: reveals no *which* | permissioned push, anonymous group membership (Semaphore) |
| **Read / confidentiality** | **Witness Encryption** to x: decrypt iff you supply w with R(x,w) | semantic security: cannot read without a witness | sealed-field decryption |

*Write-gating is the **proof-theoretic** face of R; read-gating is the
**semantic/encryption** face of R. One policy language, two duals.* This is, to my
knowledge, the cleanest statement of why Fangorn's "one condition language for
reads and writes" is not a coincidence — it is proof ⊣ encryption over a shared
NP relation.

**C (Garg voice — realizability ladder, the crucial honesty).** Witness Encryption
for **general NP** exists only from strong assumptions (multilinear maps / iO;
Garg–Gentry–Sahai–Waters lineage) and is **not** deployable. So the *theory* names
WE as the ideal; the *engineering* climbs a ladder of restricted R with real
schemes:

| Expressiveness of R | Realized by | Assumption | Status |
|---|---|---|---|
| general NP | Witness Encryption / iO | multilinear/iO | **theoretical only** — the north star |
| monotone formulas over attributes | **Attribute-Based Encryption** (KP/CP-ABE) | pairings (Boneh-style) | practical, standard |
| threshold "condition true now" | **threshold/TEE conditional decryption** (Lit) | honest-majority / TEE | deployed today |
| on-chain predicate (payment settled) | **contract-gated key release**; settlement nullifier as witness | chain security | deployed today (x402/ERC-3009 + Semaphore) |

**C:** So the design mandate: **express policies as R; compile R to the *weakest*
backend that realizes it.** A payment condition compiles to contract-gated release;
a "subscriber ∧ region" policy compiles to CP-ABE; only genuinely arbitrary R
would need WE — and the compiler should *refuse or warn* rather than silently
promise security it can't deliver.

**K:** Access is then a **compiler backend for R**, exactly parallel to the
commitment backend for Cmt and storage backend for G. Same architecture, three
target families: {commit, store, gate}. Access even becomes a *semantic
transformation*: "the view visible under capability c" is a **comonad** (a
context-indexed coalgebra) `Vis_c : Inst → Inst` extracting the readable subobject
— the dual of the reasoning monad R of §4. Reasoning *adds* meaning up a monad;
access *restricts* meaning down a comonad. Pleasing, and it says publication and
authorization are the same formalism seen through monad vs. comonad.

**C (which invariants deserve crypto — answering the brief's real question):**
- **Deserve cryptographic guarantee:** binding of the semantic commitment (§5);
  soundness of the write-authorization proof; confidentiality of sealed sections;
  honesty of *meaning-adding* passes (§4, the chase) when a consumer can't recompute.
- **Do NOT:** meaning-preserving passes (make them *canonical* and re-checkable
  instead of proven — cheaper and unconditional); embedding fidelity (§9, not a
  security property); schema conformance where the verifier can just re-run canon.
  *Prove what cannot be made canonical; canonicalize the rest.*

---

## 9. Embeddings as a lossy metric target (the least-settled corner)

**M.** Take the brief's own assumption: an embedding is a measurable map
φ : (S, Σ) → (ℝⁿ, ℬ). What is invariant across *different* embedding models? Not
the vectors (model-, rotation-, scale-dependent). The invariant is the **metric-
measure structure**: the pair (S, d, μ) — semantic (dis)similarity and the
distribution of knowledge — **up to the isometries the query metric ignores**
(cosine ⇒ up to the orthogonal group O(n); i.e. the invariant is the Gram
structure, not the coordinates).

**DEFINITION 14 (Embedding backend).** An embedding is a **lossy backend**
`Emb : Inst(𝒮) → Metric`, landing in metric-measure spaces up to isometry.
Search = querying the **pushforward measure** φ_*μ (nearest-neighbour under d).
Unlike Cmt and G (lossless, Def 5), Emb preserves only an *approximate* ordering —
so it is explicitly **not** faithful and must never be in the trusted/commitment
path.

**C.** Consequence for the protocol: PROTOCOL.md §9 is right that the *model* must
ride in the commit — because the invariant only holds *within one model's metric*.
Cross-model comparison is comparing pushforwards of different φ; no security or
correctness claim attaches. Embeddings get **no** cryptographic guarantee; at most
a *reproducibility* commitment (commit to model id + build recipe so the index is
rebuildable), which is a commitment to the *procedure*, not to semantic distance.

**B.** ANN indexes (HNSW/IVF) realize `Metric`; incremental re-embedding rides the
§5 verifiable diff. Fine at scale.

**OPEN (flagged for a specialist).** Which functor laws, if any, an embedding
should satisfy (does `Emb` preserve colimits — does fusing then embedding ≈
embedding then combining?) is genuinely unsettled and is where measure theory
currently gives *language* but few *theorems*. Candidate: treat semantic
similarity as an enrichment of Inst(𝒮) over the metric quantale ([0,∞], ≥, +)
(Lawvere metric spaces again — the **same** enrichment machinery as fuzzy fusion
in §6), making embeddings *enriched functors*. Promising, unproven.

---

## 10. Synthesis: the architecture the mathematics forces

**One object, three faces, three backend families.**

```
        frontends F_X                    canon (Def 6)               backends
 Rep_JSON ┐                                   │              ┌──► Cmt   (§5 commit)     [Poseidon2/prolly ▸ KZG/accumulator]
 Rep_RDF  ┼──►  Inst(𝒮)  ──(passes T, iso-to-id §4)──►  canon(I) ──┼──► G     (§2 storage)    [IPFS ▸ R2/CDN/libp2p]
 Rep_PG   ┤        │  (reasoning R, monad §4)                   └──► Gate  (§8 access R)   [contract ▸ ABE ▸ WE]
 Rep_SQL  ┘        └────────────── Emb (lossy §9) ─────────────────► Metric (search)      [HNSW/IVF]
```

**Map: math object → compiler stage → crypto → data structure → today's SDK.**

| Math (this memo) | Compiler stage | Crypto duty (§8 rule) | Data structure | Current SDK realization |
|---|---|---|---|---|
| Instance of algebraic schema (Def 2) | Semantic IR | — | typed row-sets / C-set | the *manifest*, but storage-shaped (to fix) |
| `canon` reflector (Def 6) | canonicalization | none (re-checkable) | **prolly tree** (history-independent) | today: sort + chunkSize (ad hoc) |
| pass = endofunctor iso-to-id (Def 7) | opt pass | preserve commitment | pure fns on IR | chunk/dedup/diff, but *fused* (COMPILER_ARCH §3) |
| reasoning monad R (Def 8) | analysis/lowering | **prove** if not recomputable | chase / Datalog | not present |
| Cmt = Cmt₀∘canon (Def 9, Law B) | commitment backend | **binding** | Poseidon2 Merkle DAG | `MerkleTree`, but not factored through canon |
| commit-DAG copresheaf (§5) | provenance | ADS soundness | Merkle DAG | `ObjectStore` (already right) |
| trust-weighted colimit (Def 11) | fusion pass | attestation of spans | linkset + view | views/linksets, missing trust weighting |
| knowledge sheaf + CRDT (§7) | sync | verifiable diff | Merkle-CRDT / prolly diff | incremental build (partial) |
| NP relation R + read/write duality (§8) | access backend | **soundness + confidentiality** | NIZK / ABE / WE / contract | Semaphore + Lit + settlement (one rung of the ladder) |
| lossy `Emb` (Def 14) | search target | none (reproducibility only) | ANN index | quickbeam |

**B's migration verdict (non-negotiables for adoption):**
1. Nothing above requires abandoning the SDK; it requires **re-typing the manifest
   as `Inst(𝒮)` and inserting `canon` before commitment** (COMPILER_ARCHITECTURE
   §3 is the first concrete step — split the fused `chunk()` around the IR).
2. Replace the ad-hoc sort/chunk with a **prolly layout** so canon, commitment,
   and incremental sync coincide (Observation 1). This is the highest-leverage
   single change.
3. Keep Poseidon2 as `Cmt₀`; keep the on-chain root byte-stable.
4. Represent policies as `R` and keep the current Lit/Semaphore/settlement stack
   as **rungs** of the §8 ladder, with a compiler that picks the weakest sufficient
   rung.

### Open problems (kept, not hidden)
- **O1.** Efficient computation of confidence-weighted (quantale-enriched) colimits
  at 10⁹ nodes (§6). Likely needs approximate/streamed colimits.
- **O2.** Functorial laws for embeddings; is `Emb` (laxly) monoidal / colimit-
  preserving? (§9) — the measure-theoretic corner.
- **O3.** A concrete, deployable scheme for policies strictly between ABE and full
  WE (§8) — the missing middle rung.
- **O4.** Cohomological conflict detection (§7): is the Čech obstruction *computable
  cheaply* enough to drive practical merge tooling, or only a conceptual invariant?
- **O5.** Whether the reasoning monad R (§4) should be *inside* the committed object
  (materialized, provable) or *outside* (recomputed by consumers) — a security ×
  cost tradeoff not yet resolved.

---

## 11. What we deliberately did NOT do
- We did not invent terminology: every object is standard (algebraic databases,
  Kan extensions, reflective localization, monads/comonads, colimits, sheaves on
  sites, quantale enrichment, NP relations, WE/ABE, ADS, CRDTs, history-independent
  structures). Novelty is only in the *arrangement* around Fangorn.
- We did not assume category theory a priori (M's charge): we tested it against
  model theory and adopted the algebraic-database synthesis because it *keeps the
  logic and gains the migration algebra*. Where category theory added nothing
  (embeddings) we used measure/metric structure instead.
- We did not add cryptography for its own sake (C's charge): §8 explicitly says
  canonicalize-don't-prove wherever a verifier can recompute.
- We did not let elegance outrun engineering (B's charge): every adopted object has
  a named data structure and a migration step, and the unresolved ones are in O1–O5.

*Next memo (v0.2) should pick ONE thread to make fully rigorous — recommended:
§3+§5 (canon ⟺ prolly ⟺ semantic commitment), because it is the load-bearing
theorem, is fully realizable today, and unblocks the concrete SDK refactor.*
