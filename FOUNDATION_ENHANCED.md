# Fangorn: a protocol for verifiable, conditionally readable graph state

*Working draft for review, 2026-10-11 · driemworks. Supersedes the structure of `FOUNDATIONS.md`; content carried over where it still holds. Revised against recent literature; §14 lists which sources were read in full.*

**How to read this draft.** The protocol is defined first: its objects, its algorithms, its parties and assumptions, and the security goals it must meet. The construction comes second, and every goal is then argued against it. Each claim carries one of four tags, so the draft cannot quietly promise more than it delivers:

| Tag | Meaning |
| --- | --- |
| **[sketch]** | A proof sketch is given; a full proof is future work |
| **[assumption]** | Holds if a stated assumption holds; nothing more is claimed |
| **[trusted]** | Holds only if a named party behaves honestly, in this version |
| **[open]** | Not achieved; stated so it is not mistaken for a guarantee |

---

## 1. Overview

A publisher who wants to share data on the open web faces three problems. Readers must be able to **find** it without revealing what they are looking for. They must be able to **trust what it is** before they are allowed to see it. And they must be able to **obtain** it once they are entitled to. Today each is solved by a server that the publisher runs and the reader trusts.

We take an opinionated view of what is being shared: application state is a collection of typed graphs, one per publisher and subspace, each versioned over time. A document is a vertex with a large payload; a catalog, a ledger of votes and an agent's memory are graphs. On top of that view we define a protocol in which:

- the latest version of every graph is recorded on a blockchain, and anyone can rebuild its full history from that record;
- parts of the state can be sealed, and sealed parts can still be checked against the application's rules;
- search runs in the reader's browser, over public descriptions only;
- sealed parts are released to readers who satisfy an on-chain condition.

The construction in §7 meets most of its goals under standard cryptographic assumptions. Release and content judgement rely on trusted parties in this version, and §9 describes how release can move to threshold encryption with silent setup.

---

## 2. Terminology

Each term is used in exactly one sense throughout.

| Term | Meaning |
| --- | --- |
| **Application (app)** | A named set of rules, terms and roles under which publishers write. Identified by `A`. |
| **App owner** | The account that registers `A`, sets its rules and terms, and appoints its operator and validator. |
| **Publisher** | An account that has accepted `A`'s terms and is authorized to write under `A`. |
| **Subspace** | A publisher-chosen partition of its data within `A`, identified by `s`. |
| **Timeline** | The version history of one `(A, p, s)`. Its on-chain key is `ns`. |
| **Graph** | One version of a timeline: a set of entity versions and edges. |
| **Entity** | A thing with stable identity across versions, identified by `eid`. |
| **Entity version** | One state of an entity, stored as a block and named by its CID. |
| **Family** | All graphs whose edges use relations from one signature Σ, regardless of app. |
| **Rule set** | The constraints `Φ_A` every graph under `A` must satisfy, committed on-chain as `h(Φ_A)`. |
| **Visibility** | Whether a timeline is **public** or **sealed**. |
| **Listing** | A public entity that describes a sealed one. |
| **Release condition** | An NP relation `R` deciding who may read a sealed timeline. |
| **Operator** | The party that checks `R` and releases keys (v1: one party; v2: a committee). |
| **Validator** | The party that judges payload content against the app's content policy. |
| **Index** | The searchable representation of an app's public entities, shipped as static files. |

---

## 3. Data model

### 3.1 Entities and versions

A content hash names a *version*, not a thing. If a trial's record changes, its CID changes, and anything pointing at the old CID now points at stale state. A system for application state needs both kinds of name:

- **Entity id.** `eid` is chosen once, when an entity is created, and never changes. Within a timeline it is unique. For sealed timelines it must be unguessable (random, or a keyed hash), since a dictionary of natural keys would let an observer confirm which entities exist.
- **Version CID.** Each entity version is a block `{eid, type, payload}`, named by the CID of its bytes.

A graph maps each live `eid` to exactly one current version.

*Status: proposed. Current code links edges by CID and has no stable entity id.*

### 3.2 Edges and references

An edge is `(src, r, dst)` where `r` is a relation and each endpoint is a reference:

| Reference | Meaning | Use |
| --- | --- | --- |
| `Local(eid)` | An entity in the same graph, resolved to its current version | Ordinary structure |
| `Live(ns, eid)` | An entity in another timeline, resolved against that timeline's current head | State that should follow updates |
| `Pinned(cid)` | One specific version, anywhere | Citation of an exact version |

Because `ns` and CIDs are global names, an edge in one publisher's graph can point into another publisher's graph, or into another app's.

### 3.3 Families

A **signature** Σ is a set of relations, each with the vertex types it may join: `(source type, relation, target type)`. The **family** `F_Σ` is the set of all graphs whose edges use only relations in Σ.

Families are independent of apps. Two apps that adopt the same Σ produce graphs in the same family, and their data can be read, linked and searched together without translation. An app chooses a signature; it does not own one.

### 3.4 Applications

An application is a tuple

$$
A = (o,\ \Sigma,\ \Phi_A,\ T_A,\ P_A,\ R_A,\ O_A,\ V_A)
$$

| Component | Meaning |
| --- | --- |
| `o` | App owner |
| `Σ` | Signature; the app's graphs lie in `F_Σ` |
| `Φ_A` | Rule set (§3.5), committed as `h(Φ_A)` |
| `T_A` | Terms publishers must accept, committed as a hash |
| `P_A(t)` | Publishers authorized at time `t`: those who accepted `T_A` and are not suspended |
| `R_A` | Release condition for the app's sealed timelines |
| `O_A` | Operator |
| `V_A` | Validator (optional) |

Each publisher `p ∈ P_A` writes to timelines

$$
ns = H(A \,\|\, p \,\|\, s)
$$

and the state of the app at time `t` is the set of current graphs of its authorized publishers:

$$
S_A(t) = \{\, G_{ns}(t) \;:\; ns = H(A \,\|\, p \,\|\, s),\ p \in P_A(t) \,\}
$$

Readers form their own views of `S_A(t)`. The protocol fixes the set, not the view.

### 3.5 Rule sets

`Φ_A` contains rules that can be checked on one graph:

- every edge's `(type(src), r, type(dst))` is in Σ, where the type of a `Live` or `Pinned` endpoint is the type declared on the reference;
- every `Local` reference resolves to a live entity of the graph;
- required fields per entity type;
- cardinality bounds per entity, such as "every outcome has exactly one `belongs_to` edge".

`Live` and `Pinned` references are not resolved by the rules; resolving them is the reader's job. We write `G ⊨ Φ_A`.

### 3.6 Visibility

Every timeline is either **public** or **sealed**. All blocks of a sealed timeline below its root are encrypted (§7.2). A seller exposes a sealed entity through a **listing**: a public entity, in a public timeline, carrying a description, metadata or a preview, and an edge `describes → Live(ns_sealed, eid)`.

Sealed payloads are never embedded or indexed. Only listings are.

### 3.7 Removal

Content-addressed history cannot be erased, and the protocol does not pretend otherwise.

- **Suspension.** When `o` suspends `p`, `p` leaves `P_A(t)`. The app stops serving and pinning `p`'s timelines. Derived data, such as `p`'s entries in the app's search index and their embeddings, is the app's responsibility to remove.
- **Copies persist.** Anyone who pinned the blocks keeps them. For public data this is final.
- **Crypto-shredding.** A sealed timeline whose keys have never been released can be made permanently unreadable by destroying its seed. Once released, it cannot.

---

## 4. Protocol syntax

The protocol is the following set of algorithms. `σ` denotes chain state.

| Algorithm | Run by | Input → output |
| --- | --- | --- |
| `RegisterApp` | `o` | `(Σ, Φ_A, T_A, R_A, O_A, V_A)` → app id `A` on-chain |
| `Join` | `p` | `(A, h(T_A))` → `p ∈ P_A` |
| `KeyGen` | `p` | `ns` → seed chain `(s_0, …, s_N)`, `anchor_ns = H(s_0)` |
| `Commit` | `p` | `(head, Δ, keys)` → commit `c`, blocks |
| `Prove` | `p` | `(c, old tree, new tree, changed blocks, s_E, Φ_A)` → proof `π` |
| `Validate` | `V_A` | `(c, plaintext of Δ)` → signature `ς` or reject |
| `Accept` | Registry | `(ns, c, π, ς)` → new `head[ns]` or reject |
| `Release` | `O_A` | `(ns, q, w, σ)` → `Enc_{pk_q}(s_E)` or ⊥ |
| `Read` | Reader | `(head[ns], blocks, keys)` → graph `G` |
| `BuildIndex` | `o` or anyone | public graphs of `A` → index `I`, committed in a public timeline |
| `Search` | Reader, locally | `(I, query)` → ranked entities |

The registry's acceptance predicate is the heart of the protocol:

$$
\mathsf{Accept}(ns, c, \pi, \varsigma) \iff
\begin{cases}
\text{caller} = p \ \wedge\ p \in P_A(t) \\
\mathsf{parent}(c) \ni \mathsf{head}[ns] \\
\mathsf{ZKVerify}\big(vk,\ \pi,\ (ns,\ \mathsf{head}[ns],\ \mathsf{root}(c),\ h(\Phi_A),\ \mathsf{anchor}_{ns})\big) & \text{if } A \text{ requires proofs} \\
\mathsf{SigVerify}\big(V_A,\ \varsigma,\ (\mathsf{chainid}, A, ns, \mathsf{root}(c))\big) & \text{if } V_A \text{ is set}
\end{cases}
$$

---

## 5. Parties, threat model and assumptions

### 5.1 Parties

| Party | Sees | May be malicious? |
| --- | --- | --- |
| Publisher `p` | Its own plaintext | Yes, toward readers and the app |
| App owner `o` | Whatever `O_A` and `V_A` see, if it runs them | Yes, toward publishers and readers |
| Operator `O_A` | Seeds it releases (v1) | **Trusted in v1** |
| Validator `V_A` | Plaintext at ingest | **Trusted in v1** |
| Storage host | Ciphertext, public blocks, fetch patterns | Yes: may drop, delay or withhold blocks |
| Chain | Registry state, transactions | No (assumption A1) |
| Reader `q` | Public data; sealed data once entitled | Yes |
| Network observer | Traffic metadata | Yes |

### 5.2 Assumptions

| Id | Assumption |
| --- | --- |
| A1 | The chain is safe and live: accepted state is final and transactions are eventually included |
| A2 | `H` (sha256) is collision-resistant; modelled as a random oracle where noted |
| A3 | HMAC-SHA256 is a PRF |
| A4 | The AEAD is a secure deterministic authenticated encryption scheme (§7.2) |
| A5 | The zkVM proof system is sound and zero-knowledge. Soundness bugs in deployed proof systems are documented [SNARK-SoK], so this is an engineering risk as well as a cryptographic assumption |
| A6 | Wallet signatures are existentially unforgeable |
| A7 | The embedding model is public and fixed by hash |
| A8 | Blocks remain available from at least one host. **Needed only for liveness, never for integrity.** With storage that supports proofs of data possession [PDP], a provider's custody of each commit's blocks can be challenged and checked rather than assumed |

---

## 6. Security goals

Each goal is stated against the adversary that threatens it. Status refers to construction v1 (§7) and is argued in §8.

| # | Goal | Statement | Status |
| --- | --- | --- | --- |
| G1 | **Authenticity** | Only `p ∈ P_A(t)` can move `head[ns]` for its own timelines | [sketch] A1, A6 |
| G2 | **History integrity** | Every accepted head extends the previous head | [sketch] for apps that require proofs; client-side only otherwise |
| G3 | **Content integrity** | A reader who fetches blocks from any host either obtains exactly the graph named by `head[ns]` or detects failure | [sketch] A2 |
| G4 | **Confidentiality up to leakage** | Without a released seed, an adversary learns nothing about a sealed timeline beyond `L_pub` (§6.1) | [sketch] A2–A4 |
| G5 | **Validity** | If `head[ns]` was accepted under `h(Φ_A)`, then the graph any entitled reader decrypts from it satisfies `Φ_A` | [sketch] A2, A5 |
| G6 | **Content conformance** | Every accepted graph's payloads satisfy the app's content policy | [trusted] `V_A` |
| G7 | **Access correctness** | A seed is released to `q` if and only if `R_A` holds for `q` | [trusted] `O_A` in v1; [sketch] in v2 under static corruption of an unauthorized set (§9) |
| G8 | **Reader privacy** | Hosts and the publisher learn nothing about a reader's queries beyond `L_read` (§6.2) | [sketch] |
| G9 | **Index integrity** | A reader can check that the index it searches matches the current public state | [sketch] A2, A7 |
| G10 | **Listing faithfulness** | Stated properties of a sealed entity, such as existence, count and linkage, hold for the sealed data | [sketch] for proven properties; [open] for semantic accuracy |
| G11 | **Availability** | Data stays retrievable | [assumption] A8; checkable with PDP-backed storage |

### 6.1 Publisher-side leakage `L_pub`

For a sealed timeline, `L_pub` consists of:

- the timeline id `ns`, and the number and timing of its commits;
- for each commit, the set of block CIDs it adds, and hence block counts, sizes, and which pages changed;
- the key epoch of each block;
- equality of identical blocks within one epoch (from deterministic encryption);
- every `eid` referenced from a public timeline, such as by a listing.

It does not include entity payloads, entity types, relations, or which entities are connected.

**This is structured encryption, and `L_pub` is its leakage profile.** Encrypting a data structure so that it can still be used, while leaking a precisely stated function of it, is the setting of structured encryption [CK10]. That literature also shows why stated leakage is not automatically harmless. Leakage-abuse attacks recover plaintext from volume and access-pattern leakage when the adversary has auxiliary knowledge of the data's distribution; Hoover et al. demonstrate this against structured encryption for SQL [HOO24]. `L_pub` contains volume (block sizes and counts) and update patterns (which pages changed, and when), so an observer who knows the domain may infer what kind of change a commit made. Two optional mitigations trade storage and latency for less leakage: padding blocks to fixed size classes and pages to fixed counts, and batching commits to blur timing. We state the leakage rather than claim it is harmless.

### 6.2 Reader-side leakage `L_read`

| Action | Learned by | Leaked |
| --- | --- | --- |
| Visiting an app and fetching the whole index | Host | That the reader visited |
| Fetching index shards on demand | Host | Which shards, and so roughly which topic |
| Fetching specific sealed blocks | Host | Which timeline and pages the reader reads |
| Requesting a seed | Operator | Which timeline and epoch, linked to the membership holder |
| Paying | Chain | A payment, unlinkable to the holder via Semaphore |

Queries themselves never leave the reader's machine. An app that wants `L_read` minimal ships its index whole.

---

## 7. Construction v1

### 7.1 Encoding

Blocks are canonical dag-cbor. A timeline's tree lists entity versions and edges in pages, closed at content-defined boundaries, so an unchanged page keeps its CID across commits. Pages are sorted by `eid` (entities) and by `(src, r, dst)` (edges), so that resolving an `eid` and checking an entity's edges are lookups rather than scans. *Status: proposed; current code sorts by CID.*

### 7.2 Sealing

Every block below a sealed timeline's root is encrypted with deterministic authenticated encryption:

$$
\mathsf{ct} = \mathsf{DAE}_{k_e}(m), \qquad \mathsf{cid} = H(e \,\|\, \mathsf{ct})
$$

- **Determinism** keeps structural sharing: equal plaintext under the same epoch key gives equal ciphertext and CID.
- **The CID is over the ciphertext.** A plaintext CID of an edge could be found by trying every relation in a small vocabulary.
- **Choice of DAE.** AES-GCM-SIV (RFC 8452) is a standard, analysed DAE scheme and is recommended. The earlier sketch (`nonce = HMAC(k, m)` truncated to 96 bits, then AES-GCM) is a synthetic-IV construction whose security argument must account for 96-bit nonce collisions between distinct messages; using AES-GCM-SIV avoids arguing it ourselves.

### 7.3 Key schedule and custody

Each sealed timeline has its own seed chain, drawn by its publisher:

$$
s_N \xleftarrow{\$} \{0,1\}^{256}, \qquad s_e = H(s_{e+1}), \qquad k_e = \mathsf{HKDF}(s_e,\ ns), \qquad \mathsf{anchor}_{ns} = H(s_0)
$$

Epoch `e` is the app's membership period. A block is sealed under the epoch in which it was written and keeps that ciphertext. Holding `s_E` yields every key up to `E` and none after it.

**Custody in v1.** By accepting `T_A`, a publisher of a sealed timeline delegates its seed chain to `O_A`. Publishers therefore trust the app's operator with their keys. This is the multi-publisher cost of v1, and the main motivation for v2.

### 7.4 Validity proofs

A zkVM guest program checks one commit. Its public output is

$$
\big(ns,\ \mathsf{root}_{\mathsf{old}},\ \mathsf{root}_{\mathsf{new}},\ h(\Phi_A),\ \mathsf{anchor}_{ns},\ \mathsf{out}\big)
$$

where `out` holds optional proven summaries (below). The guest:

1. Verifies the commit block hashes to `root_new` and names `root_old` as a parent.
2. Verifies the old and new tree blocks against `root_old` and `root_new`.
3. Derives `s_0` from `s_E` and checks `H(s_0) = anchor_ns`.
4. For every page in the new tree that is not in the old tree: verifies each block's CID, decrypts it, and checks its entities and edges against `Φ_A`.
5. For cardinality rules, also loads the existing edge pages of each affected entity (located by the `eid` sort of §7.1) and checks them, verified against the old tree.
6. Computes `out`, for example, per entity type, the count of live entities and `H(sorted eids)`.

**Incremental verifiable computation.** The per-commit proofs are an instance of incremental verifiable computation (IVC): each proof attests one step of a timeline, given that the previous state was valid. Folding schemes (Nova and its successors, including the lattice-based Neo [NEO25]) compress such a chain into a single proof whose size and verification cost do not grow with history, so a reader could check a timeline's validity without the registry storing every proof. `Live` references between timelines turn the chain into a DAG, for which proof-carrying data is the corresponding notion.

**Proven summaries are verifiable queries** over committed data, a problem studied for SQL in ZKSQL (VLDB 2023) and PoneglyphDB (SIGMOD 2025) [PON25]. Here the queries are fixed by the rule set and computed inside the same guest program.

**Proven summaries make listings checkable without cross-graph proofs.** If a sealed timeline's proof outputs `H(sorted eids of type T)`, anyone can hash the sorted `Live` targets of the matching public listings and compare. Equality shows every listing points at a real sealed entity, and every sealed entity has a listing.

### 7.5 Content validation

Structure is not content: a graph of perfectly typed edges can still carry a cat picture in a dog app. The validator judges content.

- `V_A` receives the plaintext of `Δ` at ingest, **before** sealing. It applies the app's content policy, which may include model-based judgements that cannot be proven, and signs `(chainid, A, ns, root_new)`.
- The registry requires that signature when `V_A` is set, so the validator gates commits rather than advising on them.
- `V_A` never submits commits. A gateway that calls the registry itself would collapse every publisher onto its own timeline.
- Rejections name the rule and the entity, never the payload, so the ingest endpoint does not become a plaintext oracle.
- **Trust.** In v1 `V_A` is trusted [trusted]. Moving `V_A`'s signing key into a TEE, with its attestation verified once and recorded against the app's ERC-8004 identity, narrows the trust to the hardware and the attested code without changing the registry check. That narrowing is weaker than often assumed: TEE.Fail (2025) extracted attestation keys from fully up-to-date Intel TDX/SGX and AMD SEV-SNP machines using a DDR5 bus interposer costing under $1,000 [TEEF25]. A TEE validator is therefore meaningful only against adversaries without physical access to the hardware, and is treated here as defence in depth, not as a trust anchor.

### 7.6 Registry

The registry implements `Accept` (§4). For apps that require proofs, it also stores `anchor_ns` on the timeline's first proven commit, and requires a proof from the empty graph whenever `h(Φ_A)` changes.

### 7.7 Release (v1)

A reader `q` sends `O_A` a signed request `(ns, E, t)` with its membership token. `O_A` checks `R_A` against chain state:

$$
R_A\big((ns, q, \sigma),\ \mathsf{tok}\big) = 1 \iff \mathsf{canRead}_\sigma(\mathsf{tok}, q).\mathsf{until} > \mathsf{now}
$$

If it holds, `O_A` returns `s_E` encrypted to `q`'s public key, for the current epoch `E`.

### 7.8 Discovery

- **Listings only.** The index contains public entities and listings, never sealed payloads.
- **One shared space.** Every corpus is embedded with the same public model (A7) into one 256-dimensional space. Queries are embedded locally. A reader's taste is a small Markov kernel over that space, roughly 350 bytes, owned and carried by the reader.
- **The index is committed.** `BuildIndex` writes the index's CID and the sorted set of indexed `eid`s into a public timeline of the app, so the index is part of the state rather than an unversioned file next to it.

---

## 8. Analysis

Each goal is argued against v1. Sketches are written to be checkable, not complete.

**G1, authenticity [sketch].** Only a transaction signed by `p` can call `Accept` for `ns = H(A‖p‖s)` with caller `p` (A6), and the registry checks `p ∈ P_A(t)`. Since `ns` binds `p`, no other account can name `p`'s timeline as its own. Holds given A1 and A6.

**G2, history integrity [sketch].** For apps that require proofs, the registry checks `head[ns] ∈ parent(c)` on-chain before moving the head, so every accepted head extends its predecessor (A1). For apps without proofs, the current code checks ancestry only in the client before submitting, so G2 holds against honest publishers only. The protocol should move the parent check into the registry for all apps; it costs one comparison.

**G3, content integrity [sketch].** Every block is named by the hash of its bytes, and every link in the tree is a CID. A host that returns different bytes for a CID produces a collision (A2). So a reader either rebuilds exactly the graph named by `head[ns]` or detects a mismatch. This holds against any host; availability is separate (G11).

**G4, confidentiality up to `L_pub` [sketch].** Hybrid argument. (1) Replace each epoch key `k_e` by an independent random key: keys for distinct epochs are HKDF outputs of distinct chain elements, which are pseudorandom to anyone without a later seed (A2 as random oracle, one-wayness of `H`). (2) Replace each DAE ciphertext of a distinct plaintext by a random string of the same length (A4); DAE security guarantees this up to equality of repeated plaintexts, which is in `L_pub`. (3) What remains (CIDs of random strings, their sizes, epochs, commit structure and publicly referenced `eid`s) is exactly `L_pub`. A simulator given `L_pub` produces the same distribution. *Caveat: the argument needs `eid`s to be unguessable (§3.1), and is cleanest with AES-GCM-SIV (§7.2).*

**G5, validity [sketch].** By induction on accepted commits of `ns` since the last proof from the empty graph. Base: the empty graph satisfies any `Φ_A` consisting of the rules in §3.5. Step: suppose the graph at `root_old` satisfies `Φ_A` and the registry accepts `root_new` with a proof. By soundness (A5), the guest's checks hold. Every page of `root_new` is either in `root_old` (valid by hypothesis, and unchanged by A2) or was checked in step 4; cardinality rules were rechecked for every affected entity in step 5. The anchor check binds the decryption keys to `anchor_ns`, so the plaintext the guest checked is the plaintext any reader holding a released seed will decrypt. *Gap: step 5's completeness for cardinality depends on the edge-page sort of §7.1, which is proposed, not implemented.*

**G6, content conformance [trusted].** Holds exactly when `V_A` applies the policy honestly. With a TEE it reduces to the TEE's integrity and the attested code, which excludes adversaries with physical access (§7.5); no cryptographic proof is claimed.

**G7, access correctness.** v1 [trusted]: `O_A` holds seeds, so G7 holds if and only if `O_A` is honest. v2 [sketch]: by the static tag-based security of the policy-based scheme (§9.2), a set of corrupted committee members that does not satisfy the policy learns nothing about `s_E`. A requester obtains `s_E` only with partial decryptions on `τ = H(ns ‖ E)` that satisfy the policy, each released only after its signer checked `R_A`. The argument inherits the scheme's limits: static corruption, and a trusted common reference string.

**G8, reader privacy [sketch].** Queries are embedded and ranked locally, so no party receives them. What remains observable is the fetch and request pattern, which is exactly `L_read` (§6.2). For indexes too large to ship whole, private search over public embeddings is an established technique: Tiptoe scores an encrypted query against public embeddings with linearly homomorphic encryption, so an untrusted host ranks documents without learning the query [TIP23]. Such a host need not be trusted for privacy, so it does not reintroduce a trusted server. A further leak in v1 is that the operator links seed requests to the membership holder; §9 removes it.

**G9, index integrity [sketch].** The index's CID and its sorted `eid` set are committed in a public timeline (§7.8). A reader checks (i) the index bytes against the committed CID (A2), and (ii) the committed `eid` set against the `eid`s of the public graphs it indexes, which detects omitted or invented entries. Vectors are recomputable from public text and the public model (A7), within a floating-point tolerance. Ranking quality is not a security property and is not claimed.

**G10, listing faithfulness.** Existence, count and linkage between listings and sealed entities are proven via proven summaries (§7.4) [sketch]. Whether a listing's prose accurately describes the payload is not provable in general [open]; it is attributable to a known publisher, and the validator can check it at ingest [trusted].

**G11, availability [assumption].** Integrity never depends on availability (G3); liveness does (A8). Storage with proofs of data possession, such as Filecoin's PDP, lets anyone challenge a provider to show it still holds a ready-to-serve copy of a commit's blocks [PDP], which turns A8 from hope into something monitored. It still does not force a provider to serve.

### Summary

| Goal | v1 status | Rests on |
| --- | --- | --- |
| G1 Authenticity | [sketch] | A1, A6 |
| G2 History integrity | [sketch] for proven apps | A1; registry change for others |
| G3 Content integrity | [sketch] | A2 |
| G4 Confidentiality up to `L_pub` | [sketch] | A2–A4, unguessable `eid`s |
| G5 Validity | [sketch] | A2, A5; eid-sorted pages |
| G6 Content conformance | [trusted] | `V_A` (TEE later) |
| G7 Access correctness | [trusted] | `O_A`; v2 removes |
| G8 Reader privacy | [sketch] | Local search |
| G9 Index integrity | [sketch] | A2, A7 |
| G10 Listing faithfulness | [sketch] / [open] | Proven summaries / validator |
| G11 Availability | [assumption] | A8, PDP-checkable |

---

## 9. v2: release as practical witness encryption

**The ideal** is witness encryption: seal `s_E` under the statement "`R_A` holds for the requester", so that anyone with a witness can decrypt and no one else can. In general it is impractical. The practical relaxation is to let a committee attest to the statement, and to encrypt so that enough attestations act as the witness.

### 9.1 The formal frame: signature-based witness encryption

Signature-based witness encryption (SWE) [MCF24, SWE24] encrypts a message to a **tag** and a set of signature verification keys; anyone holding signatures on the tag from at least `k` of those keys can decrypt. Timelock encryption is the case where the tag is a round number and the committee is a beacon. Our release is the case where the tag is

$$
\tau = H(ns \,\|\, E)
$$

and an operator signs `τ` only after checking `R_A` for the requester. McFly, the first practical SWE, is slow at committee scale (encryption 9.8 s and decryption 14.8 s for 500 signers, as reported), so we use it as the definition, not the instantiation.

### 9.2 The instantiation: silent-setup, policy-based encryption

Two constructions give SWE-like behaviour with **silent setup**: every party publishes its own key, and the joint encryption key for any set of parties is a deterministic function of their keys, with no dealer and no distributed key generation.

| | Silent-setup threshold encryption [GKPW24] | Waters–Wu [WW26] |
| --- | --- | --- |
| Policies | Thresholds | Any monotone policy with a linear secret-sharing scheme, including monotone Boolean formulas and conjunctions of thresholds |
| Ciphertext | 10 group elements (as reported in [WW26]) | 4 group elements plus a short tag |
| Partial decryption | Per party | A party's Boneh–Boyen-style signature on the ciphertext's tag |
| Security | Generic group model | Static, tag-based CCA security from a q-type assumption in the plain model |
| Common reference string | Linear in the number of parties `N` | `O(N²)` for formulas; `O(N log N)` for thresholds |
| Weighted thresholds | Supported by related SNARK-based schemes | Not supported; left open by the authors |
| Prior implementation | `fangorn-rs` (authors' prototype) | None known |

Waters–Wu fits the frame exactly: decryption is defined as aggregating signatures on the tag. We therefore target it for v2, with [GKPW24] as the implemented baseline.

**Two costs must be stated.** First, "plain model" does not mean "no setup": the scheme needs a structured common reference string whose size grows quadratically with the policy bound `N`, so it requires a setup ceremony or a trusted source, much like the powers-of-tau setups used for KZG commitments. Second, security is static: corruptions are fixed before the keys are used, which matches committees that are chosen per epoch but should be stated as a limitation.

### 9.3 The mapping

1. Operators publish keys; any set of published keys can form a committee.
2. Per epoch, the publisher encrypts `s_E` under tag `τ = H(ns ‖ E)` to the committee's policy, publishes the ciphertext, and may go offline.
3. An operator that receives a request checks `R_A` on-chain and, if it holds, returns its partial decryption (its signature on `τ`), encrypted to the requester.
4. Once the requester's partial decryptions satisfy the policy, it decrypts `s_E` locally. No operator ever holds `s_E`.

This also resolves the custody problem of §7.3: publishers no longer hand seeds to the app's operator.

### 9.4 Composing gadgets as policies

A gadget pairs a release condition with a committee that attests to it. With policies beyond thresholds, gadgets compose. Take one committee that checks membership and another that runs a time beacon. The policy "a majority of the membership committee **and** a majority of the beacon committee" releases only to members after a given time. Conjunctions of thresholds are exactly the example policy class Waters and Wu give. The gadget registry of `fangorn-rs` becomes a registry of committees and the conditions they attest to.

### 9.5 Removing the operator's view of who is reading

In v1, and in §9.3 as written, operators see which membership holder requests which timeline. Threshold anonymous credentials with silent setup [TAC25] let a committee of issuers jointly issue a credential that its holder shows without revealing which credential it is, again without a distributed key generation. Used as the membership witness, the operator learns that some valid member asked, not which one. The authors report a Rust implementation.

### 9.6 Batching and scale

Batched threshold encryption decrypts many ciphertexts with communication independent of their number [CGPP24]. BEAST-MEV combines batching with silent setup, motivated by encrypted mempools, with security in the generic group model and an implementation [BEAST25]. For Fangorn, the corresponding workload is releasing every timeline's seed for a new epoch at once. Weighted committees, which Waters–Wu leave open, are addressed by a 2026 batched and weighted scheme that we have not yet reviewed.

### 9.7 Prior work by the authors and open problems

An earlier prototype, `fangorn-rs`, implemented this direction: a Rust peer-to-peer network using silent-setup threshold encryption over Iroh, an on-chain intent registry, and an extensible gadget framework ("intent-bound data"). v2 returns to that design with a data layer underneath it.

Open problems: a requester holding enough partial decryptions can pass them on, which is no worse than passing on the plaintext. How committees are selected, paid and rotated per epoch is an economic question. All of the schemes above are pairing-based and so not post-quantum; silent threshold encryption with plausible post-quantum security is an active line of work [STE-PQ25].

## 10. Limitations and non-goals

- **Deletion.** History is permanent (§3.7). Only never-released sealed data can be destroyed.
- **Publisher key loss or rotation.** A timeline is bound to one account. Rotation is not specified.
- **Concurrent writers.** One publisher writing from several devices must serialize commits; there is no merge. This is deliberate (contrast WNFS, which merges as a CRDT) but limits multi-device use.
- **Fair exchange.** Membership payments go directly to the app owner, so buyers trust delivery. Fair exchange of digital goods through a smart contract is well studied: FairSwap resolves disputes optimistically through the contract [FS18], later work spans FairSwap and OptiSwap with a tunable trade-off, and SmartZKCP repairs known flaws in zero-knowledge contingent payments for data marketplaces [SZK24]. Our goods are 32-byte seeds checkable against `anchor_ns`, which is about the cheapest case these protocols handle. Future work.
- **Post-quantum security.** The hash-based parts (content addressing, key regression, sealing) are unaffected. The pairing-based release mechanisms of §9 and pairing-based proof systems are not post-quantum.
- **Multi-publisher custody (v1).** See §7.3.
- **Availability.** See G11.

---

## 11. Evaluation plan

| Question | Measurement |
| --- | --- |
| Is proving practical? | Proving time and proof size against number of changed pages, on a laptop CPU, for real app commits |
| What does sealing cost? | Bytes uploaded per commit, sealed versus public, for the same edit history (structural sharing should make these nearly equal) |
| How much leaks? | `L_pub` measured on a real sealed timeline: what an observer can infer from page changes and timing |
| What do readers leak? | `L_read` for whole-index versus sharded-index apps |
| What does verification cost on-chain? | Gas for `Accept` with and without proof and validator checks |

---

## 12. Related work

| Work | Relation |
| --- | --- |
| Structured encryption [CK10] | The general setting of §6.1 and §7.2 |
| Leakage-abuse attacks [HOO24] | Why `L_pub` must be stated and, where it matters, padded |
| AES-GCM-SIV (RFC 8452) | Recommended DAE in §7.2 |
| Key regression (Fu, Kamara and Kohno, NDSS 2006) | Used in §7.3 |
| [WNFS](https://github.com/wnfs-wg/spec) | Encrypted, versioned, content-addressed file system and CRDT. A file tree, not a typed graph; no on-chain anchor or rules; its private forest hides more structure than v1; its skip ratchet appears to derive keys forward, where key regression derives backward |
| Peergos | Encrypted capability-based storage on IPFS; no committed rules |
| Ceramic / ComposeDB | Schema-validated streams on IPFS; public data |
| [Twine](https://docs.twine.world/) | Signed, hash-linked IPLD chains entwined across authors for ordering without consensus. Close to our timelines; no encryption, rules or access control |
| Folding and IVC [NEO25] | §7.4: one proof per timeline |
| ZKSQL, PoneglyphDB [PON25] | Verifiable queries over committed data; §7.4's proven summaries |
| Signature-based witness encryption [MCF24, SWE24] | The formal frame of §9 |
| Silent-setup threshold encryption [GKPW24] | Implemented baseline for §9 (`fangorn-rs`) |
| Waters–Wu [WW26] | Target instantiation for §9; policies compose gadgets |
| hinTS [HINTS24] | Silent-setup threshold signatures; aggregating operator attestations |
| Threshold anonymous credentials [TAC25] | §9.5: membership witness that hides the holder |
| Batched threshold encryption [CGPP24, BEAST25] | §9.6: releasing many seeds per epoch |
| Statement-oblivious threshold witness encryption (CSF 2023) | Committee-based witness encryption that also hides the statement; relevant to hiding which timeline is requested |
| Registered ABE | Attribute-based encryption without a trusted key issuer; no deployment found |
| drand / tlock | Timelock as practical witness encryption |
| Tiptoe [TIP23] | Private search over public embeddings; §8 G8 |
| FairSwap, SmartZKCP [FS18, SZK24] | Fair exchange; §10 |
| Filecoin PDP [PDP] | Checkable availability; G11 |
| TEE.Fail [TEEF25] | Limits of TEE attestation; §7.5 |
| Lit Protocol | Threshold access-control network; a possible committee behind `R_A` |
| Semaphore | Anonymous membership in v1 |
| ERC-8004 | Agent identity. Its Validation Registry is still in draft and being revised with the TEE community, so this design depends on identity only |
| `fangorn-rs` | The authors' earlier prototype of §9 |

## 13. Open questions

1. **Proving cost** for realistic commits, including cardinality rechecks (§7.4 step 5).
2. **Tight `L_pub`**, and how much a WNFS-style private forest would remove.
3. **Entity ids in practice:** migrating existing CID-linked graphs, and choosing `eid`s for public versus sealed timelines.
4. **Resolving `Live` references** across timelines efficiently, and what a reader should do when one dangles.
5. **Listing accuracy** beyond what proven summaries cover.
6. **Committees** for v2: selection, payment, rotation.
7. **Fair exchange** between buyers and publishers.
8. **Ranking every app** against a query without downloading every index.

---

## 14. References and reading status

**Read in full for this draft:** [WW26]. **Read from abstracts or summaries:** all others. Venue claims marked (?) need checking.

| Key | Reference |
| --- | --- |
| [WW26] | B. Waters, D. J. Wu. Silent Threshold Cryptography from Pairings: Expressive Policies in the Plain Model. Eurocrypt 2026. [ePrint 2025/1547](https://eprint.iacr.org/2025/1547) |
| [GKPW24] | S. Garg, D. Kolonelos, G.-V. Policharla, M. Wang. Threshold Encryption with Silent Setup. CRYPTO 2024. [ePrint 2024/263](https://eprint.iacr.org/2024/263) |
| [MCF24] | N. Döttling, L. Hanzlik, B. Magri, S. Wohnig. McFly: Verifiable Encryption to the Future Made Practical. FC 2024. [ePrint 2022/433](https://eprint.iacr.org/2022/433) |
| [SWE24] | G. Avitabile, N. Döttling, B. Magri, C. Sakkas, S. Wohnig. Signature-based Witness Encryption with Compact Ciphertext. Asiacrypt 2024. [ePrint 2024/1477](https://eprint.iacr.org/2024/1477) |
| [HINTS24] | S. Garg, A. Jain, P. Mukherjee, R. Sinha, M. Wang, Y. Zhang. hinTS: Threshold Signatures with Silent Setup. IEEE S&P 2024. [ePrint 2023/567](https://eprint.iacr.org/2023/567) |
| [TAC25] | Garg, Garg, Policharla, Roberts. Threshold Anonymous Credentials with Silent Setup. [ePrint 2025/2042](https://eprint.iacr.org/2025/2042) |
| [CGPP24] | A. R. Choudhuri, S. Garg, J. Piet, G.-V. Policharla. Mempool Privacy via Batched Threshold Encryption. USENIX Security 2024 |
| [BEAST25] | J. Bormet, A. R. Choudhuri, S. Faust, S. Garg, H. Othman, G.-V. Policharla, Z. Qu, M. Wang. BEAST-MEV: Batched Threshold Encryption with Silent Setup for MEV Prevention. [ePrint 2025/1419](https://eprint.iacr.org/2025/1419) |
| [STE-PQ25] | Silent Threshold Encryption with One-Shot Adaptive Security. [ePrint 2025/1384](https://eprint.iacr.org/2025/1384) |
| [CK10] | M. Chase, S. Kamara. Structured Encryption and Controlled Disclosure. Asiacrypt 2010 (?) |
| [HOO24] | A. Hoover et al. Leakage-Abuse Attacks Against Structured Encryption for SQL. USENIX Security 2024. [ePrint 2024/554](https://eprint.iacr.org/2024/554) |
| [NEO25] | W. Nguyen, S. Setty. Neo: Lattice-based Folding Scheme for CCS over Small Fields. [ePrint 2025/294](https://eprint.iacr.org/2025/294) |
| [PON25] | B. Gu, J. Fang, F. Nawab. PoneglyphDB. SIGMOD 2025. [arXiv 2411.15031](https://arxiv.org/abs/2411.15031) |
| [TIP23] | A. Henzinger et al. Private Web Search with Tiptoe. SOSP 2023. [ePrint 2023/1438](https://eprint.iacr.org/2023/1438) |
| [FS18] | S. Dziembowski, L. Eckey, S. Faust. FairSwap: How to Fairly Exchange Digital Goods. CCS 2018. [ePrint 2018/740](https://eprint.iacr.org/2018/740) |
| [SZK24] | SmartZKCP. [ePrint 2024/941](https://eprint.iacr.org/2024/941) |
| [PDP] | Filecoin. [Proof of Data Possession](https://filecoin.io/blog/introducing-proof-of-data-possession-pdp-verifiable-hot-storage-on-filecoin) |
| [TEEF25] | TEE.Fail, October 2025. [Coverage](https://thehackernews.com/2025/10/new-teefail-side-channel-attack.html) |
| [SNARK-SoK] | SoK: What Don't We Know? Understanding Security Vulnerabilities in SNARKs. [arXiv 2402.15293](https://arxiv.org/abs/2402.15293) |

