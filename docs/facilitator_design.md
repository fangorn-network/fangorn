# x402f Facilitator Design — Forking PrivateX402

> Companion to [`CONTRACT_MIGRATION.md`](./CONTRACT_MIGRATION.md). That document covers the
> Settlement Registry → Predicate Registry migration. This document specifies the **x402f
> facilitator**: the protocol by which a buyer converts a *private payment* into an *anonymous
> on-chain admission*, and the plan to build it by forking
> [PrivateX402](https://github.com/ConorNethermind/PrivateX402).
>
> §§2–5 are the formal core (read these first). §§6–11 are the engineering plan.

---

## 1. Problem Statement

Three parties — a **publisher** (seller, offline after publishing), a **buyer/agent**, and a
**facilitator** (the only always-online party) — must jointly realize:

- **(P1) Access correctness.** A buyer who pays for resource $\mathsf{rid}$ can obtain access to $\mathsf{rid}$.
- **(P2) No free access.** A buyer who has not paid cannot obtain access.
- **(P3) Payment–access unlinkability.** No party — *including the facilitator* — can link a
  particular payment to the on-chain admission/fetch it later authorizes.
- **(P4) Non-interactivity.** The publisher signs nothing per purchase and holds no per-buyer
  state. Only the facilitator is online.

The facilitator is the trusted intermediary that decouples payment from access (the Stripe
pattern), but trusted *only* for settlement integrity (P2), **not** for privacy (P3) — that is
enforced cryptographically below.

---

## 2. Notation and Primitives

Fix a security parameter $\lambda$. Let $\mathbb{F}_r$ denote the scalar field of the [BabyJubjub](https://docs.iden3.io/publications/pdfs/Baby-Jubjub.pdf)
curve (the native field of our Poseidon hash and EdDSA signatures).

**Hash functions** — Poseidon instances with distinct, hard-coded domain-separation tags;
modeled as random oracles for the analysis in §5:

| Symbol | Type | Domain tag | Purpose |
|---|---|---|---|
| $H_{\mathrm{res}}$ | $\{0,1\}^* \to \{0,1\}^{256}$ | $\texttt{"fangorn:resourceId"}$ | resource identifier (matches the registry) |
| $H_{\mathrm{com}}$ | $\mathbb{F}_r \to \mathbb{F}_r$ | $\texttt{"fangorn:cred:commit"}$ | secret $\to$ commitment |
| $H_{\mathrm{null}}$ | $\mathbb{F}_r \times \{0,1\}^{256} \to \mathbb{F}_r$ | $\texttt{"fangorn:cred:null"}$ | (secret, resource) $\to$ nullifier |

Domain separation is **required**: $H_{\mathrm{com}}$ and $H_{\mathrm{null}}$ take the same
secret $s$ as input, and the whole privacy argument (§5, P3) rests on their outputs being
unlinkable without $s$.

**Signature scheme** $\Sigma = (\mathsf{KeyGen}, \mathsf{Sign}, \mathsf{Verify})$ — EdDSA over
BabyJubjub with Poseidon, **EUF-CMA secure**, chosen because $\mathsf{Verify}$ is cheap *inside a
SNARK circuit*.

**NIZK** $\Pi = (\mathsf{Setup}, \mathsf{Prove}, \mathsf{Verify})$ — a zk-SNARK (Honk/UltraPlonk
via Barretenberg) that is **knowledge-sound** and **zero-knowledge** for the relation
$\mathcal{R}_{\mathrm{cred}}$ defined in §4.

**Semaphore** — unchanged from current Fangorn. A buyer holds a Semaphore identity whose public
**identity commitment** is $\mathsf{idc} \in \mathbb{F}_r$. Admission $=$ inserting
$\mathsf{idc}$ into the resource's group.

---

## 3. Public Values

**Resource identifier.** Every access-controlled field has a public, deterministic identifier
recomputable by anyone:

$$
\mathsf{rid} \;:=\; H_{\mathrm{res}}\big(\,\textsf{publisher} \,\|\, \textsf{schemaId} \,\|\, \textsf{datasetNameHash} \,\|\, \textsf{recordNameHash} \,\|\, \textsf{fieldNameHash}\,\big) \;\in\; \{0,1\}^{256}.
$$

This is the *same* $\mathsf{rid}$ the predicate registry and the decryption TEE key on. The
buyer learns $\mathsf{rid}$ — together with the price $\mathsf{price}(\mathsf{rid})$ and the
facilitator's public key — from the **x402f $402$ response** when it first hits the resource.
$\mathsf{rid}$ is public throughout.

**Facilitator key.** Once, at setup, the facilitator runs
$(\mathsf{sk}_F, \mathsf{pk}_F) \leftarrow \Sigma.\mathsf{KeyGen}(1^\lambda)$ inside its enclave
(§6) and registers $\mathsf{pk}_F$ on-chain via attestation. $\mathsf{pk}_F$ is public and
appears in the gadget's parameters for any resource that accepts this facilitator.

---

## 4. The Credential Protocol

The buyer draws a single fresh secret $s$ per purchase; everything else is derived from it.

### 4.1 Issue  (buyer $\leftrightarrow$ facilitator)

**Buyer.** Sample $s \xleftarrow{\$} \mathbb{F}_r$ (fresh per purchase, kept private forever) and
form the **commitment**

$$
c \;:=\; H_{\mathrm{com}}(s).
$$

Send $(\mathsf{rid}, c)$ to the facilitator together with an x402 payment of
$\mathsf{price}(\mathsf{rid})$.

**Facilitator (inside enclave).** Assert the payment was received, then return the **credential**

$$
\sigma \;:=\; \Sigma.\mathsf{Sign}\big(\mathsf{sk}_F,\; c \,\|\, \mathsf{rid}\big).
$$

The facilitator's entire view of this purchase is $(\mathsf{rid}, c, \textsf{payment})$. Because
$c = H_{\mathrm{com}}(s)$ is one-way, **the facilitator never learns $s$** — and that single fact
is what makes the later redemption unlinkable to this payment (§5, P3). The credential $\sigma$
is the facilitator's attestation that *"the holder of the secret behind $c$ paid for
$\mathsf{rid}$."* The commitment $c$ exists precisely so the facilitator can **vouch without
learning the secret that will anonymize redemption.**

### 4.2 Redeem  (buyer $\to$ predicate registry, via relayer)

The buyer admits a Semaphore identity commitment $\mathsf{idc}$ to $\mathsf{rid}$'s group
*without* revealing $s$, $c$, or $\sigma$. Define the **nullifier**

$$
\nu \;:=\; H_{\mathrm{null}}(s \,\|\, \mathsf{rid}) \qquad \text{(deterministic in } (s,\mathsf{rid})\text{; one per credential).}
$$

The circuit enforces the relation $\mathcal{R}_{\mathrm{cred}}$ on statement
$x = (\mathsf{pk}_F, \mathsf{rid}, \mathsf{idc}, \nu)$ and witness $w = (s, \sigma)$:

$$
\mathcal{R}_{\mathrm{cred}}(x, w) = 1
\;\;\Longleftrightarrow\;\;
\underbrace{\Sigma.\mathsf{Verify}\big(\mathsf{pk}_F,\; H_{\mathrm{com}}(s) \,\|\, \mathsf{rid},\; \sigma\big) = 1}_{\text{valid paid credential}}
\;\;\wedge\;\;
\underbrace{\nu = H_{\mathrm{null}}(s \,\|\, \mathsf{rid})}_{\text{correct nullifier}}.
$$

Note $c$ is *not* a separate input: the circuit recomputes $H_{\mathrm{com}}(s)$ from the witness
$s$ and checks the signature against it. The identity commitment $\mathsf{idc}$ is a public
input, so the proof is cryptographically bound to it (a verifier or relayer cannot swap in a
different identity — see P5).

**Buyer.** Compute $\pi \leftarrow \Pi.\mathsf{Prove}(\mathsf{crs}, x, w)$ and submit (relayed,
so the buyer wallet never appears):

$$
\textsf{register}(\mathsf{rid},\, \mathsf{idc},\, \pi,\, \nu).
$$

**Predicate Registry.** Maintain a spent-nullifier set $\mathsf{Spent}$ and enforce

$$
\Pi.\mathsf{Verify}(x, \pi) = 1
\;\;\wedge\;\;
\nu \notin \mathsf{Spent};
\qquad\text{then}\qquad
\mathsf{Spent} \mathrel{:=} \mathsf{Spent} \cup \{\nu\},
$$

and add $\mathsf{idc}$ to the Semaphore group of $\mathsf{rid}$. After this, `settle` (Semaphore
membership $\to$ on-chain nullifier $\to$ `isSettled`), the stealth address, and the decryption
TEE `unseal` proceed exactly as in current Fangorn.

### 4.3 Bearer vs. bound credentials (a one-line policy choice)

The signed message determines transferability:

- $\Sigma.\mathsf{Sign}(\mathsf{sk}_F,\, c \,\|\, \mathsf{rid})$ → **bearer**: anyone who learns
  $(s, \sigma)$ can admit *any* $\mathsf{idc}$.
- $\Sigma.\mathsf{Sign}(\mathsf{sk}_F,\, c \,\|\, \mathsf{rid} \,\|\, \mathsf{idc})$ → **bound**:
  the credential is fixed to one identity at issuance (the circuit then verifies over
  $H_{\mathrm{com}}(s) \,\|\, \mathsf{rid} \,\|\, \mathsf{idc}$).

Bearer credentials are resellable; bound credentials are not. Pick per product policy (§10).

---

## 5. Security Properties

Each property is a claim with a proof sketch, under: $H_{\mathrm{com}}, H_{\mathrm{null}}$ random
oracles; $\Sigma$ EUF-CMA; $\Pi$ knowledge-sound and zero-knowledge.

**(P1) Correctness.** An honest buyer holding $\sigma = \Sigma.\mathsf{Sign}(\mathsf{sk}_F, c\|\mathsf{rid})$
for $c = H_{\mathrm{com}}(s)$ satisfies both conjuncts of $\mathcal{R}_{\mathrm{cred}}$ with
$\nu = H_{\mathrm{null}}(s\|\mathsf{rid})$, so $\Pi.\mathsf{Prove}$ yields an accepting $\pi$;
$\nu$ is fresh, so the registry admits $\mathsf{idc}$. $\qquad\blacksquare$

**(P2) No free access (unforgeability).** Suppose a buyer makes `register` accept for
$\mathsf{rid}$ without ever having been issued a credential for $\mathsf{rid}$. By
knowledge-soundness of $\Pi$, extract a witness $(s, \sigma)$ with
$\Sigma.\mathsf{Verify}(\mathsf{pk}_F, H_{\mathrm{com}}(s)\|\mathsf{rid}, \sigma) = 1$. Since the
enclave signs $c\|\mathsf{rid}$ only upon payment (§6), $\sigma$ is a signature on a message the
issuer never signed — an EUF-CMA forgery against $\Sigma$. Contradiction. $\qquad\blacksquare$

**(P3) Payment–access unlinkability.** The facilitator's issuance view is $c = H_{\mathrm{com}}(s)$;
the public redemption view is $\nu = H_{\mathrm{null}}(s\|\mathsf{rid})$ (plus $\mathsf{idc}$,
chosen freshly by the buyer). To link a redemption to a payment, an adversary — the facilitator
included — must decide, given $c$ and $\nu$, whether they share the same $s$. In the ROM, $c$ and
$\nu$ are independent random images of $s$ under domain-separated oracles; absent a query at $s$,
the linking advantage is negligible in $\lambda$. Zero-knowledge of $\Pi$ ensures $\pi$ reveals
nothing beyond $x$. Hence no party links payment to admission. $\qquad\blacksquare$

> *Residual leakage (outside cryptographic scope):* the facilitator learns *that* someone paid
> for $\mathsf{rid}$ (it must, to settle), and network/timing metadata are uncovered. The seller
> and the chain learn neither buyer nor amount — the amount is hidden by settlement netting
> (§7).

**(P4) Double-spend resistance.** $\nu = H_{\mathrm{null}}(s\|\mathsf{rid})$ is a deterministic
function of the credential; $\mathsf{Spent}$ rejects any second redemption of the same
credential. $\qquad\blacksquare$

**(P5) Non-malleability / front-running resistance.** $(s, \sigma)$ never leave the witness; only
$(\mathsf{pk}_F, \mathsf{rid}, \mathsf{idc}, \nu, \pi)$ are public. By knowledge-soundness, $\pi$
is valid only for the exact statement it was produced for, so an observer/relayer who swaps
$\mathsf{idc}$ invalidates $\pi$ and cannot redirect the admission. $\qquad\blacksquare$

**Trust assumptions, made explicit.** P2 relies on "enclave signs iff paid" (§6) — the *only*
integrity trust placed in the facilitator. P3 holds even against a fully malicious facilitator.
No party is trusted for content/keys (the decryption TEE / threshold net holds those, gated on
`isSettled`).

---

## 6. TEE Architecture

Inherit PrivateX402's host/guest enclave + attestation, and run **credential issuance inside the
enclave**. This discharges the "signs iff paid" assumption P2 depends on: the enclave verifies
the payment before invoking $\Sigma.\mathsf{Sign}(\mathsf{sk}_F, \cdot)$, and attestation lets
anyone check that the registered $\mathsf{pk}_F$ belongs to an enclave running exactly this
logic. The operator outside the enclave sees only attested outputs, so it cannot mint unpaid
credentials or selectively censor undetectably.

Keep **two enclave roles as separate processes** sharing the host/attestation crate:

1. **Facilitator enclave** (new, from PrivateX402): holds $\mathsf{sk}_F$, verifies payments,
   issues credentials, generates settlement proofs.
2. **Decryption enclave** (existing Fangorn): holds the X25519 seal key, `unseal`s on
   `isSettled`. Do **not** fold issuance into it — its minimal trust surface is the point.

Either can later be swapped for a threshold network independently; both only ever sign/unseal or
read `isSettled` — neither verifies gadget circuits (those are verified on-chain).

---

## 7. Why PrivateX402, and What to Reuse

The facilitator is a hub, and PrivateX402 already implements the money flows on *both* sides:

- **Buyer → Facilitator** $\approx$ a PrivateX402 **channel** (fund once, draw down via
  off-chain signed receipts) → the "shielded prepaid balance" of §10(3).
- **Facilitator → Publishers** $\approx$ PrivateX402 **settlement**: facilitator funds,
  publishers are recipients, per-recipient amounts hidden by the blinding scheme + epoch hash
  chain, batched claims. This netting hides *amounts* from the seller and chain (the P3
  residual).

What PrivateX402 lacks, and what §§3–5 specify, is the **credential bridge** (private payment →
anonymous third-party admission) and the **HTTP $402$** layer (explicitly out of scope upstream).

| Component (PrivateX402) | Disposition |
|---|---|
| Trait system (`Proof`, `ProofClient`, `IVerifier`, `IBlindingScheme`, `IHasher`, `ISignatureVerifier`) | **Inherit** |
| TEE host/guest, attestation, on-chain key registration | **Inherit** → §6 |
| `BalanceTree<H>`, blinding (Keccak/Poseidon2), epoch hash chain | **Inherit** → facilitator→publisher settlement |
| Channel + cumulative signed receipts | **Modify** → buyer→facilitator prepaid balance (§10.3) |
| Axum HTTP servers | **Modify** → add x402f $402$ surface (§3) |
| Noir circuits + `cross_language_vectors.json` fixtures | **Inherit scaffolding** → add the $\mathcal{R}_{\mathrm{cred}}$ circuit |
| `PrivateX402.sol` channel lifecycle | **Keep for settlement** (distinct contract — §8) |
| EIP-191 signatures | **Keep on-chain (settlement); replace in-circuit with EdDSA-BabyJubjub (credential)** |
| Credential bridge ($\mathcal{R}_{\mathrm{cred}}$), x402f $402$ | **Build** |

---

## 8. Contract Boundary

Two distinct contracts, sharing only the facilitator-as-actor:

- **Predicate Registry** (migrated Settlement Registry): verifies $\pi$ against
  $\mathcal{R}_{\mathrm{cred}}$, manages Semaphore groups + the $\mathsf{Spent}$ nullifier set +
  `isSettled`. *The Fangorn contract.*
- **Settlement contract** (forked `PrivateX402.sol`): facilitator↔publisher channels, blinded
  amounts, epoch hash chain, batched claims. *The money-movement contract.*

Different trust roles, different upgrade cadences — keep them separate.

---

## 9. First Milestone (end-to-end, single gadget, no channels)

$$
\textsf{x402f }402 \;\to\; \textsf{pay facilitator (enclave verifies, returns } \sigma\textsf{)} \;\to\; \textsf{build } \pi \textsf{ for } \mathcal{R}_{\mathrm{cred}} \;\to\; \textsf{register}(\mathsf{rid}, \mathsf{idc}, \pi, \nu) \;\to\; \textsf{settle} \;\to\; \textsf{unseal} \;\to\; \textsf{settle to publisher}
$$

- $402 \to$ pay facilitator; enclave verifies, returns $\sigma$ (§4.1).
- Buyer computes $\nu$, builds $\pi$ for $\mathcal{R}_{\mathrm{cred}}$ (§4.2).
- $\textsf{register}(\mathsf{rid}, \mathsf{idc}, \pi, \nu)$ — registry admits $\mathsf{idc}$.
- `settle` (Semaphore, unchanged) → decryption TEE `unseal` on `isSettled` (unchanged).
- Facilitator nets settlement to the publisher (PrivateX402, §7).

Write the **cross-language golden fixture for the credential encoding** (Rust issuer ↔ Noir
$\mathcal{R}_{\mathrm{cred}}$ ↔ Solidity/Stylus verifier) *before* the circuit — encoding /
Poseidon2 mismatches are exactly where PrivateX402's own Noir integration is currently stuck.

---

## 10. Open Decisions

1. **In-circuit signature** — EdDSA-BabyJubjub/Poseidon (recommended; cheap $\mathsf{Verify}$ in
   $\Pi$) vs. Chaumian blind-RSA (facilitator provably blind *at issuance*, on-chain modexp
   verify, but breaks the uniform "every gadget is one Honk verify" router and changes the P3
   argument).
2. **Credential binding** — bearer ($c\|\mathsf{rid}$) vs. bound ($c\|\mathsf{rid}\|\mathsf{idc}$),
   per §4.3.
3. **v1 payment model** — per-purchase direct pay (recommended) vs. buyer channels now (§7).
4. **Enclave topology** — two processes (recommended, §6) vs. one.
5. **Facilitator multiplicity** — single Fangorn-run facilitator vs. a registry of competing
   facilitators (gadget param becomes a facilitator-id instead of a literal $\mathsf{pk}_F$).
6. **Settlement cadence** — per-payment / batched / netted-per-epoch (netting maximizes the
   amount-privacy of the P3 residual; it is PrivateX402's native model).

---

## 11. Summary

- The credential is a **fresh secret $s$** turned into a commitment $c = H_{\mathrm{com}}(s)$ the
  facilitator signs ($\sigma$), and a nullifier $\nu = H_{\mathrm{null}}(s\|\mathsf{rid})$
  revealed at redemption. A single zk-SNARK proof of $\mathcal{R}_{\mathrm{cred}}$ ties them
  together and admits a Semaphore $\mathsf{idc}$.
- $c$ exists so the facilitator can **vouch without learning $s$**; that is the hinge of
  unlinkability (P3).
- Security rests on three standard assumptions — $\Sigma$ EUF-CMA ($\Rightarrow$ no free
  access), $\Pi$ knowledge-soundness $+$ ZK ($\Rightarrow$ binding $+$ proof privacy),
  domain-separated ROs ($\Rightarrow$ payment↔access unlinkability) — plus one operational
  assumption discharged by attestation: the enclave **signs iff paid**.
- Fork PrivateX402 for both money legs, the TEE/attestation, the trait system, and the
  cross-language fixtures; **build** only the credential bridge ($\mathcal{R}_{\mathrm{cred}}$)
  and the x402f $402$.
- Keep the predicate registry and the settlement contract separate. Ship the per-purchase,
  single-gadget path end-to-end first.
