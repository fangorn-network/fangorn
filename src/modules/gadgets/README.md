# Gadgets

A gadget represents a logical access condition with public inputs that gates decryption of a Fangorn-encrypted field. Gadgets are baked into the ciphertext at publish time as human-readable descriptors. They define the access control condition that gates data (the condition a consumer must satisfy) and the `SettlementRegistry` hook that is triggered on settlement. It must be able to produce a gadget descriptor: a human-and-agent readable descriptor stored in the manifest.

The framework is extensible: you can implement your own gadget for any access condition expressible as an EVM contract call.

---

## The `Gadget` Interface

Each gadget must extend the [Gadget](./types.ts) interface.

**`hookAddress()` / `hookParams()`** — The `SettlementRegistry` calls this contract (if non-zero) as an effect of a successful ZK membership proof during `claim()`. Use this to trigger any on-chain side effect that settlement should produce — minting an access token, updating a registry, etc. If your gadget has no side effect beyond writing `isSettled`, return `zeroAddress` and `"0x"`.

**`toAccessCondition()`** — Produces the Lit Protocol ACC array that is baked into the ciphertext at encryption time. This is the actual cryptographic gate: decryption will only succeed if the caller satisfies this condition at the time of decryption. It must be consistent with what `hookAddress` / the settlement registry writes on-chain.

**`toDescriptor()`** — Produces the `GadgetDescriptor` stored in the manifest entry alongside the ciphertext handle. This is how consumers and agents discover what they need to do to unlock a field before committing to a purchase.

---

## Built-in Gadgets

| Gadget | Condition |
|---|---|
| `SettledGadget` | Caller's stealth address must appear as settled in `SettlementRegistry` for the given `resourceId` |

More coming soon ;)

---

## Example: `SettledGadget`

The [SettledGadget](./settledGadget.ts) is the default built-in. It gates decryption on `SettlementRegistry.isSettled(stealthAddress, resourceId)`. Because the registry writes settled state directly after ZK proof verification, the gadget has an empty hook contract.

### Usage

Gadgets are configured at encryption time.

``` ts
const { manifestCid } = await this.delegatorFangorn.publisher.upload({
    records,
    schema,
    schemaId,
    gateway,
    gadgetFactory: (tag) => new SettledGadget({
        resourceId: SettlementRegistry.deriveResourceId(owner, schemaId, tag),
        settlementRegistryAddress: this.config.settlementRegistryContractAddress,
        chainName: this.config.chainName,
        pinataJwt: this.pinataJwt,
    }),
}, price);
```


---

## Implementing a Custom Gadget

Each gadget must:

1. Extend the `Gadget` interface
2. Deploy a hook contract (optional): if your gadget needs an on-chain side effect at settle time (e.g. mint an NFT, verify freshness, etc), deploy a contract and return its address from `hookAddress()`. ABI-encode any params and return them from `hookParams()`.
3. **Write the ACC**: Currently, the gadgets framework only supports Lit protocol. Use `createAccBuilder()` from `@lit-protocol/access-control-conditions` to express the decryption condition as an EVM contract call. The condition must be satisfiable by a consumer who has completed your intended flow.
4. **Wire it into `gadgetFactory`**: pass your gadget via the `gadgetFactory` callback in `publisher.upload()`:

```ts
await fangorn.publisher.upload(
  {
    records,
    schema,
    schemaId,
    gateway,
    gadgetFactory: (tag) => new MyCustomGadget({
      resourceId: SettlementRegistry.deriveResourceId(owner, schemaId, tag),
      // ...your params
    }),
  },
  price,
);
```

The `resourceId` passed to your gadget should always be derived with `SettlementRegistry.deriveResourceId(owner, schemaId, tag)`. This is the canonical identifier the registry uses to track settlement state per resource.