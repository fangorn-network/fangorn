# Encryption architecture sketch

Status: **investigation, not implemented**. This is a design sketch produced after reviewing
[storacha/specs#130](https://github.com/storacha/specs/issues/130) / draft spec
[PR #132](https://github.com/storacha/specs/pull/132) (`w3-encrypt.md`) and the reference
implementation [storacha/lit-storacha-demo](https://github.com/storacha/lit-storacha-demo). It
proposes how PROTOCOL.md §8 ("FUTURE: who can read") could actually be built on top of the
current pail-based `FangornEngine`, and what stays true to the "bring your own backend" gadget
idea vs. what's Lit-specific for a v1.

---

## 1. What prior art gets us

PROTOCOL.md §12 already calls this: "the read gate (decrypt-iff-rule)" is a **Buy — Lit
Protocol** decision, on the grounds that standing up our own threshold/TEE network isn't worth
it. Two things confirm that call is sound:

- Storacha independently arrived at the same architecture (`w3-encrypt.md`, PR #132) and shipped
  a working demo of it.
- That demo's actual trust mechanism turns out to be **generic**, not Lit-specific in the way it
  first looks. Section 2 explains why that matters for the gadget-registry idea.

## 2. The key mechanism: Lit's ACC is a pointer, not the policy

The demo's `accessControlConditions` don't encode "who can decrypt." They encode one thing only:

```js
// src/scripts/encrypt-and-upload.js
{
  parameters: [':currentActionIpfsId', space.did()],
  returnValueTest: { comparator: '=', value: env.STORACHA_LIT_ACTION_CID }
}
```

Translation: "only release the key if the caller is executing *this exact, immutable Lit Action*,
identified by its own IPFS CID." Lit's threshold network cryptographically enforces that one
fact and nothing else. All real authorization — delegation chains, capability derivation,
resource matching — is ordinary application code running **inside** that Lit Action
(`src/lit-actions/validate-decrypt-invocation.js`), executing in Lit's TEE:

```js
const authorization = await access(wrappedInvocation, {
  principal: Verifier,
  capability: Decrypt,               // a plain @ucanto capability() definition
  authority: 'did:web:web3.storage', // hardcoded verifier identity
  validateAuthorization: () => ok({})
})
// only on success:
Lit.Actions.decryptAndCombine({ accessControlConditions, ciphertext, dataToEncryptHash, ... })
```

So the "gadget" is: **arbitrary, auditable code, deployed once to IPFS, pinned by CID.** Lit's
ACC engine is repurposed purely as a trust anchor pointing at that CID — anyone can read the
Lit Action source, confirm it does what it claims, and the security property reduces to "trust
that this published, immutable bytecode implements the check correctly."

This is a direct match for PROTOCOL.md §8's claim that read-gates and write-gates should share
**one condition language**: the `Decrypt` capability in the demo is a plain ucanto
`capability()` — the same primitive Fangorn's future push-auth gate (§7) would use. A
Fangorn-specific Lit Action could run Fangorn's own write-gate capability logic verbatim for
reads.

## 3. Double encryption (why large files aren't a problem)

`src/lib.js: encryptLargeFile()`:

1. Generate a random AES-256-CBC key + IV **locally**.
2. Encrypt the actual file bytes with that key, streamed (no size limit, content never touches
   Lit).
3. Encrypt only the 48-byte `(key, iv)` blob via Lit's `encryptString` — this is the thing
   actually gated by the ACC / Lit Action.

The result is packaged as `EncryptedMetadata` (dag-cbor, matches `w3-encrypt.md`'s schema):

```ts
type EncryptedMetadata = {
  encryptedDataCID: Link<any>          // CID of the AES-encrypted bytes
  identityBoundCiphertext: Uint8Array  // Lit-wrapped (key, iv)
  plaintextKeyHash: Uint8Array
  accessControlConditions: Record<string, any>[]
}
```

This resolves the open question from PROTOCOL.md §8 ("the data doesn't have to be
re-encrypted"): changing *who can read* means re-wrapping the small key blob under a new ACC —
not re-encrypting the payload. Cheap, and it matches "a new commit pointing at a new rule."

## 4. Mapping onto Fangorn's current pail engine

Grounding in the actual code (`src/engine/index.ts`), not the demo's file-upload model:

```ts
export interface Vertex {
  schemaId: SchemaID;
  payload: Record<string, any>;
}
```

`stageVertex()` dag-cbor encodes a `Vertex` block, puts it in the blockstore, and writes a pail
entry at `${namespace}/v/${cid}`. `listNamespace()` walks the pail, resolves each `v/` entry's
CID, and `dagCbor.decode`s it back into `{ cid, schemaId, payload }`.

The natural seam is **payload-level sealing**, not whole-vertex sealing — `schemaId` stays
public (needed for `metagraph.validateVertex`), only `payload` (or specific fields within it)
gets sealed:

```ts
export interface Vertex {
  schemaId: SchemaID;
  payload: Record<string, any> | SealedPayload;
}

interface SealedPayload {
  sealed: true;
  encryptedDataCID: CID;           // AES-encrypted payload bytes, stored as a separate block
  identityBoundCiphertext: Uint8Array;
  plaintextKeyHash: Uint8Array;
  accessControlConditions: Record<string, any>[];
}
```

- **`stageVertex`**: if a schema/field is marked sealed (schema-level flag, e.g. an extra
  `sealedFields: string[]` on `VertexSchema`), run the double-encryption step before
  `encodeBlock`, write the AES-ciphertext as its own block, embed the `SealedPayload` struct in
  the `Vertex` block that goes into the pail. Everything else about staging/committing/pail
  structure is unchanged — sealing is a payload transform, not a new tree shape.
- **`listNamespace`**: decode as today; if `payload.sealed`, return the `SealedPayload` struct
  as-is instead of resolved plaintext. A separate `decryptVertex(vertex, invocation)` call
  (mirroring `download-and-decrypt.js`) does the Lit Action round trip on demand, lazily, only
  for callers who hold a valid delegation. Reading a namespace never requires decrypting
  everything in it up front.
- **Rule changes without re-encryption**: re-running the encrypt step against a new ACC and
  staging a new `Vertex` block (new CID) that points at the *same* `encryptedDataCID` is exactly
  "a new commit pointing at a new rule" from §8 — the AES-encrypted payload block is immutable
  and reused.

## 5. What a Fangorn-specific gadget needs

Reusing this pattern for real means Fangorn owns, not borrows, these pieces:

1. **Its own Lit Action**, deployed to IPFS, pinned by CID — analogous to
   `validate-decrypt-invocation.js` but checking a Fangorn capability (e.g. `namespace/vertex/decrypt`)
   instead of `space/content/decrypt`, and validating against Fangorn's own `authority` DID
   rather than `did:web:web3.storage`.
2. **Its own ACC convention**: `[':currentActionIpfsId', <fangorn's Lit Action CID>]` — the CID
   becomes a protocol constant, the same way `STORACHA_LIT_ACTION_CID` is a fixed env value in
   the demo.
3. **A capability definition** mirroring `Decrypt` in `decrypt-capability.js` — `with` bound to
   the publisher/namespace DID, `nb.resource` bound to the vertex CID (not a whole-file root),
   `derives` enforcing exact match on both.
4. **A gadget registry entry** (per PROTOCOL.md §8's "onchain gadget registry" concept) that
   records "vertices sealed under condition X resolve via Lit Action CID Y" — this is what keeps
   the abstraction backend-agnostic: a different registry entry could point at a different
   backend (self-managed keys, a TEE, another MPC network) implementing the *same* capability
   shape, without changing how vertices are staged or how `listNamespace` treats sealed payloads.

## 6. Where this stays a gadget vs. where it's Lit-specific for v1

**Backend-agnostic (survives a future backend swap):**
- The `Vertex.payload.sealed` shape and the double-encryption split (AES payload + wrapped key).
- The capability/condition language (ucanto capabilities) — same one used for write-gate.
- The registry-points-at-a-resolver indirection.

**Lit-specific for v1 (would need a new gadget adapter to swap out):**
- `accessControlConditions` format is Lit's own DSL.
- The "ACC pins a specific IPFS CID" trick is a Lit Action mechanism specifically; a different
  TEE backend would need an equivalent enforcement primitive, not necessarily this exact shape.
- Session-sig / capacity-credit mechanics (`getSessionSigs`, `getCapacityCredits` in
  `src/lib.js`) are Lit SDK plumbing with no Fangorn analogue yet.

## 7. Suggested order of work (not started)

1. Fork the demo's encrypt/decrypt round trip standalone (no Fangorn integration yet) against a
   Lit testnet, replacing its `Decrypt` capability and `authority` DID with Fangorn placeholders,
   to confirm the mechanism works end-to-end before touching `engine/index.ts`.
2. Define `SealedPayload` and a minimal `sealField`/`unsealField` pair as pure functions,
   independent of storage — no pail/blockstore changes yet.
3. Wire `stageVertex`/`listNamespace` to use them behind a schema-level opt-in flag.
4. Only then design the on-chain gadget registry piece — it's the part with the least prior art
   to lean on (the demo doesn't have one; it hardcodes the Lit Action CID in env vars).
