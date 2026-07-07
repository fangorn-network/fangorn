# Settlement Registry Migration — Payment Gate → Predicate Verifier

> Migrate the Settlement Registry from an x402/ERC-3009 **payment service** into a
> general **predicate verifier**: a registry that proves *things*, not just payments.
> Payment unlinkability is delegated to the **x402f facilitator** (a trusted payment
> processor) plus **blind-issued credentials** — not to a Fangorn-operated mixer.

---

## 1. Goal & Constraints

**Goal.** `register` stops carrying an ERC-3009 `transferWithAuthorization` and instead
verifies a proof that a buyer satisfies a **predicate** (a "gadget"). On success it admits
the buyer's `identity_commitment` to the resource's Semaphore group. Everything downstream
(`settle` → stealth → TEE) is unchanged.

**Hard constraints (load-bearing — do not violate):**

- **Non-interactive between buyer and seller.** The publisher **publishes once, then is
  offline forever.** No per-purchase signing, no per-buyer state maintained by the publisher.
- **No Fangorn-operated pool / mixer.** We do not custody or shuffle buyer funds. Avoids the
  legally gray "mixer operator" posture.
- **Publisher accountability is desired.** We explicitly do **not** want publisher privacy.
  The publisher/issuer is public and accountable for what they publish.
- **Stay on EVM / Arbitrum Stylus.** No migration to Midnight or any non-EVM chain. Keep
  USDC, viem/ethers, the existing agent/x402 economy.

---

## 2. Chosen Architecture — Facilitator + Blind Credential

The confidential primitive that breaks the (buyer, seller, amount) link is **intermediation
by the x402f facilitator**, not a shielded pool. This is the Stripe pattern: an intermediary
processes the payment, so the seller and the chain never see the buyer.

**Flow:**

1. Agent hits the resource → receives an **x402f** `402` response carrying the resource's
   **predicate** (gadget id + params), the **price**, and the **facilitator** to pay.
2. Agent pays the **facilitator** in USDC (ordinary x402). *The publisher is never contacted.*
3. The facilitator issues a **blind-signed credential** for `resourceId`. Because it signs a
   *blinded* message, even the facilitator cannot later link the payment to the redemption.
4. Agent unblinds and presents the credential to the **Predicate Registry** (the former
   Settlement Registry). The registry verifies the facilitator's signature and admits the
   agent's `identity_commitment` to the resource's Semaphore group.
5. `settle` (Semaphore membership proof → nullifier → `isSettled`), the stealth address, and
   the TEE gate (`unseal` on `isSettled`) proceed **exactly as today**.

**Where each unlinkability comes from:**

| Adversary | What they see | What's hidden |
|---|---|---|
| **Publisher (seller)** | "Facilitator F settled N to me" | which buyer, per-buyer amount |
| **Chain / public** | a facilitator attestation was verified; a commitment joined a group; later an anonymous settle | any buyer→amount edge |
| **Facilitator** | "someone paid for resource R" (it must, to settle correctly) | payment→redemption link (blind issuance); who fetches (Semaphore + stealth) |
| **TEE / threshold net** | the `isSettled` bit only | everything else |

**Why not Railgun:** trustless, but heavy circuits, coupling to an external protocol's note
format, gas, and the buyer needs pre-shielded funds (UX friction). The facilitator path is
native to x402f, cheap (a blind signature, not a membership SNARK), and publisher-offline.

**Trust the facilitator carries (bounded & legitimate):**
- ✅ Trusted for **settlement integrity** — only issues a credential if actually paid, and
  settles with the publisher. Same trust as any payment processor / x402 facilitator.
- ❌ **Not** trusted for privacy — blind issuance means it can't link payment↔redemption.
- ❌ **Not** trusted for data/keys — the TEE (later, a threshold network) holds those.

> **Threat-model note:** the facilitator *does* learn (buyer, seller, amount) at payment time,
> because it is the processor. This is acceptable under "facilitator = trusted processor." If
> a future requirement demands the facilitator also be blind to this, the *only* path is a
> trustless confidential rail (e.g. Railgun) — a separate, heavier gadget, not this migration.

---

## 3. What Stays Frozen (small blast radius)

Everything downstream of "`identity_commitment` is in the group" is untouched:

- `settle` — Semaphore membership proof → nullifier → sets `isSettled`. **Unchanged.**
- Stealth address binding (the Semaphore proof's `message`). **Unchanged.**
- TEE: `seal`/`unseal` bound to `resourceId`, gate on `isSettled`. **Unchanged.**
- Future threshold-network swap — still just reads the `isSettled` bit. **Unaffected.**
- `MemberRegistered` event + group reconstruction. **Unchanged.**

> Semaphore is **not** the leak and must **not** be removed. It provides which-member
> anonymity (it hides *which* group member authorizes the fetch). The only historical leak was
> that `register` welded a cleartext payment to group admission. Decouple them and Semaphore
> delivers the fetch-side unlinkability it was always providing.

---

## 4. Contract Surface — Before / After

### Before (payment gate)

```
register(
    resourceId, identityCommitment,
    // ERC-3009 transferWithAuthorization payload
    from, to, amount, validAfter, validBefore, nonce, v, r, s
)
```

### After (predicate verifier)

```
register(
    resourceId,
    identityCommitment,
    gadgetId,                 // which predicate (e.g. FacilitatorCredential)
    publicInputs,             // resourceId, identityCommitment, credential serial, ...
    predicateProof,           // the credential / proof satisfying the gadget
    bindingMerkleProof,       // proves (gadgetId, paramsHash) ∈ publisher's predicate root
    leafIndex
)
```

`register` now:
1. Verifies `bindingMerkleProof` — the resource is genuinely bound to this gadget + params
   in the publisher's committed root (publish-once, see §6).
2. Dispatches to `router[gadgetId].verify(publicInputs, predicateProof)`.
3. On success, adds `identityCommitment` to the resource's Semaphore group + records any
   anti-replay nullifier/serial as spent.

Submitted via the existing **relayer** so the buyer's wallet is never linked to the commitment.

- `createResource` / `updateResource` keep the **group-creation** role. The `price` argument
  becomes optional/legacy (price is now a gadget param, not a first-class field).
- `setRegistry` (admin) — unchanged.
- The existing `hook` / `hookData` scaffolding **is** the predicate-dispatch seam; promote it
  to the gadget router.

---

## 5. Predicate (Gadget) Registry

Make the half-present `hook` concept real. A gadget entry:

```
gadgetId → {
    verifier,            // verifying key (preferred) OR verifier contract
    publicInputSchema,   // shape & order of public inputs
    semantics            // human-readable: what condition this proves
}
```

**Recommendation:** a **governed router table** (`gadgetId → verifier`) rather than baking a
verifier address into each binding leaf. It is upgradeable, discoverable, and matches "gadgets
registered against a schema" from `docs/encryption.md`. Publishers reference a `gadgetId` +
params at publish time and never deploy anything.

**Universal public-input convention:** every gadget's public inputs MUST include at least
`resourceId` and `identityCommitment`, so a proof is bound to *this* resource and *this* group
admission and cannot be replayed elsewhere.

**v1 gadget — `FacilitatorCredential`:**
- **params:** facilitator public key (or its id in a facilitator registry), price.
- **predicateProof:** the unblinded, facilitator-signed credential for `resourceId`.
- **verify:** check the facilitator's signature over `(resourceId, serial)` and that `serial`
  is unspent; record `serial` spent.
- **Unlinkability:** facilitator signed a *blinded* message → cannot correlate issuance to
  this redemption.

This is an **anonymous credential** (Chaumian / BBS+ / Privacy-Pass family), not a SNARK over
an external note tree — deliberately the cheap, native primitive.

> Other gadgets (`OwnsAsset`, `BalanceOver`, `MembershipInSet`, and later `PaymentVia(Railgun)`)
> slot behind the same router with their own verifying keys, each normalizing to the same
> output: "admit `identity_commitment`." **Do not build the gadget zoo now** — ship
> `FacilitatorCredential` end-to-end first (§7).

---

## 6. Generalize the Committed Leaf (price → predicate binding)

Preserve the bulk-commit / publish-once property of the DataSource Registry. Today a manifest
leaf commits content CIDs and the design references a `price` leaf; generalize the **leaf
content**, not the tree:

```
leaf = (field_id, gadgetId, paramsHash)      // was: (resource, price)
```

- Same Poseidon2 Merkle tree, same single on-chain root per datasource, same bulk upload.
- `register` proves `binding_leaf ∈ publisher_root` (`bindingMerkleProof`) **and** the
  predicate is satisfied.
- Price, if retained, is just a field inside a gadget's `paramsHash`.
- **Design guide (publish-once):** prefer predicates over state the publisher does **not**
  maintain (facilitator signatures, live chain state, external registries). Anything requiring
  the publisher to add members later breaks publish-once.

---

## 7. Migration Phases

| Phase | Work | Done when |
|---|---|---|
| **P0 — Interface freeze** | Define the universal `register(...)` shape (§4) and the public-input convention. Pick proof/signature system for `FacilitatorCredential` (a blind-signature scheme; SNARK-wrap only if not EVM-cheap). | Interface + ABI agreed; no ERC-3009 in the signature. |
| **P1 — Leaf generalization** | DS-registry leaf `price → (gadgetId, paramsHash)`. Keep bulk-commit + single root. | Publisher can commit predicate bindings once and go offline. |
| **P2 — Gadget router** | Promote `hook`/`hookData` to a governed `gadgetId → verifier` table + gadget registration. | Router verifies a registered gadget's proof on-chain. |
| **P3 — Rework `register`** | verify binding proof → dispatch to router → admit `identity_commitment`. Remove ERC-3009 path. `price` arg → optional. | New `register` admits via `FacilitatorCredential`; old payment path gone. |
| **P4 — x402f issuance** | Facilitator issues **blind-signed** credentials on x402 payment; x402f `402` response carries gadget + facilitator + price. | Buyer pays facilitator, gets credential, registers — publisher never contacted. |
| **P5 — End-to-end validation** | One resource: x402f → pay facilitator → credential → `register` → `settle` → TEE `unseal`. | Full pipe green with `FacilitatorCredential` only. |
| **P6 — Decommission** | Remove price-specific logic / `getPrice`. Document any retained transparent-payment gadget as fetch-unlinkable-only. | Registry is a pure predicate verifier. |

**Do not boil the ocean:** P5 with a single gadget validates the entire framework. Additional
gadgets are just more verifying keys behind the same router.

---

## 8. Open Decisions

1. **Blind-signature scheme for `FacilitatorCredential`.** Chaumian blind RSA (simple,
   battle-tested), BBS+ (selective disclosure, SNARK-friendly), or VOPRF/Privacy-Pass.
   Drives on-chain verification cost and the credential format.
2. **Verifying-key management.** One verifier with per-gadget VKs registered in the router
   (less code, upgradeable — recommended) vs. a verifier contract per gadget.
3. **Facilitator registry / multiplicity.** One Fangorn-run facilitator first, or a registry
   of competing facilitators a publisher can opt into at publish time? Affects the
   `FacilitatorCredential` params (facilitator pubkey vs facilitator id).
4. **Credential ↔ identity binding.** Does the blind credential commit to the buyer's
   `identity_commitment` at issuance (tighter binding, prevents credential transfer) or only
   to `resourceId` + serial (transferable bearer credential)? Sets the anti-replay model.
5. **Settlement timing.** Facilitator settles with the publisher per-payment, batched, or
   netted? Batched/netted strengthens the seller-side unlinkability of amounts.

---

## 9. Summary

- **Settlement Registry → Predicate Registry.** It proves entitlements, not payments.
- **Unlinkability via the x402f facilitator** (trusted processor) **+ blind credentials** —
  native, cheap, EVM-only, publisher-offline. No mixer operated by Fangorn.
- **Semaphore stays** (fetch-side anonymity); `settle` / stealth / TEE untouched.
- **Payment becomes one gadget** (`FacilitatorCredential`) behind a governed router; the
  trustless `PaymentVia(Railgun)` gadget is a later, optional add for a stricter threat model.
- **Ship `FacilitatorCredential` end-to-end first**; generalize after.
