# Encryption and Private Purchases

Fangorn enables field-level encryption of data. That is, in Fangorn you first define a *shema*, the shape of the data. We introduce two custom types so that we can:

1) reference externally available data, where we must indicate *where* the data is and *how* to get it. For example, an IPFS CID + Gateway combo, or an R2 resource id + webworker URL.
2) enable field-level encryption of data under a well-defined, verifiable condition. More specifically, publishers should be able to configure bespoke rules at a field-level within a schema. 

From a UX perspective, we don't want users to have to encrypt and then use Fangorn, instead, the schema language/DSL should allow a user to leverage the Fangorn SDK to encrypt their data under a given gadget.

For example, the SDK should take public inputs and encrypt them on behalf of the user, registering their access control condition onchain.

Currently, the SDK only supports **public inputs**. So, we need to introduce a new type for informing the SDK that we need to encrypt the data and register the gadget. 

That is, right now we only support things like:

``` json
{
    "publicInput": {
        "@type": "string"
    }
}
```

but we need to be able to support field level encryption under a 'gadget', e.g.:

``` json
{
    "privateInput": {
        "@type": "Estring",
        "plaintext": "abc123...",
        "gadget": "Payment(USDC, 1)",
        "registry": "0xabc123.."
    }
}
```

would be transformed to something like the following (the idea is we can do r2, ipfs, whatever really):
f
``` json
"data": {
    "@type": "handle",
    "resourceLocator": "r2://123abc... | ipfs://abc123...",
    "gateway": "https://worker.fangorn.network/abcdefg | https://ipfs.gateway.com/ipfs",
    "gadget": "Payment(USDC, 1)",
    "registry": "0xabc123.."
}
```

For this, we will, for now, assume that uploading parties must be pre-authorized somehow, likely by signing up, submitting a formal fiat payment (e.g. via stripe) and getting a JWT that would allow them to authenticate with the webworker /upload endpoint. This initial version of encryption will be done via a TEE rather than a committe (i.e. the silent threshold encryption network), simply because it's easier, cheaper, and surely has less bugs (STE is experimental still).

We may want to explore this for datasets in general, actually, as r2 has free egress while pinata does not. Thus, migrating the 'meat' of things to r2 could be a significant cost saving at scale. Plus, uploads to pinata are VERY SLOW, like 3mbps? so the process is really cumbersome.

## Gadgets

Rather than 'roll your own access control',  we can provide pre-defined mechanisms for encryption. A gadget represents a pre-defined condition for decryption and how to meet that condition. More explicitly, it encodes conditions that can be proved with zero-knowledge based on public conditions. For example, a gadget may stipulate that a caller must prove they submitted a payment, or that they must own a given asset, hold a minimum balance, be in a given group, and so on. The primary goal is for the decrypting party to retain anonymity, with no relationship between buyer/seller linked on-chain. Additionally, buyers should *never* expose the inputs to the gadget. That is, if a buyer must prove they've paid for a resource, then there must be no link from (buyer, seller, payment amount).

### Gadget Registry

Gadgets are registered within the schema registry against a schema. That is, we define a generic 'gadget' shape, and the we publish implementations against. Each implementaton, like "payment", "time", or "ownership" must correlate to a real, provable condition. For example, if the condition is "payment" then the caller must prove they have submitted a valid payment. 

``` json
{
    "@type": "gadget",
    "name": {
        "@type": "string"
    },
    "inputParams": {
        "@type": "array",
        ...
        "constraints":  {
            ...
        }
    }
}
```

And then we instantiate a specific gadget based on the generic schema, e.g.

``` json
{
    "@type": "gadget",
    "name": "Payment",
    "inputParams": {
        "@type": "array",
        "constraints":  {
            "kind": "enum",
            "values": ["USDC", "USDT", "DAI"]
        }
    }
}
```

Once the gadget is defined in the gadget registry, it can be used for encryption. We are not implementing "real" witness encryption here, unfortunately, but simply approximating it using zkps. So, at encryption time, the gadget itself is irrelevant: we simply encrypt against the TEE public key by doing a key exchange (ECDH) and encrypt using AES GCM client-side. 

This is where I'm not entirely sure how to proceed. If we want this to be generalizable, then the gadget *must*  correlate to some confgurable, on-chain, condition within the settlement registry. Currently, the settlement registry is really an x402-payment-only gate, which is not precisely the right move here. That is, the function signature looks like: 

```  rust 
 /// Register a buyer's identity commitment for a specific resource.
/// The buyer presents a merkle proof against the publisher's current
/// price root (stored in the DS registry), proving price + owner validity.
#[payable]
pub fn register(
    &mut self,
    // Resource identity components — used to derive resource_id and to
    // look up the publisher's price_root on the DS registry.
    publisher:           Address,
    schema_id:           FixedBytes<32>,
    dataset_name_hash:   FixedBytes<32>,
    record_name_hash:    FixedBytes<32>,
    field_name_hash:     FixedBytes<32>,
    // Proven values from the price manifest leaf.
    price:               U256,
    owner:               Address,
    merkle_proof:        Vec<FixedBytes<32>>,
    leaf_index:          U256,
    // Buyer identity for Semaphore.
    identity_commitment: U256,
    // ERC-3009 transferWithAuthorization payload.
    from:                Address,
    to:                  Address,
    amount:              U256,
    valid_after:         U256,
    valid_before:        U256,
    nonce:               FixedBytes<32>,
    v:                   u8,
    r:                   FixedBytes<32>,
    s:                   FixedBytes<32>,
) -> Result<(), SettlementError>
``` 

where the `price` field would exist as a leaf in a merkle tree. This is also where things are getting tricky quite quickly. The way the datasource regsitry works is that we take data, chunk it into leaves in a Merkle tree, and the we upload all the leaves to IPFS and commit to the root onchain. This allows for efficient bulk uploads and ensures that we only need to make on on-chain commitment per datasource (the chunking also means we avoid the tax incurred by NOT chunking due to the increased number of intermediary leaves). However, 'price' is probably the wrong primitives to go with here. Realistically, the idea is 'proof over permission', so rather than submitting a payment here, this should actually require a zkp. In that sense, the publisher should be responsible for registering a circuit somewhere. This circuit should be tied to the specific instantiation of the gadget that they've specified when uploading their data. 

That is, maybe we need something more akin to:

```  rust 
 /// Register a buyer's identity commitment for a specific resource.
/// The buyer presents a merkle proof against the publisher's current
/// price root (stored in the DS registry), proving price + owner validity.
#[payable]
pub fn register(
    &mut self,
    // Resource identity components — used to derive resource_id and to
    // look up the publisher's price_root on the DS registry.
    publisher:           Address,
    schema_id:           FixedBytes<32>,
    dataset_name_hash:   FixedBytes<32>,
    record_name_hash:    FixedBytes<32>,
    field_name_hash:     FixedBytes<32>,
    // Proven values from the price manifest leaf.
    owner:               Address,
    merkle_proof:        Vec<FixedBytes<32>>,
    leaf_index:          U256,
    // Buyer identity for Semaphore.
    identity_commitment: U256,
    // the zkp
    proof: __SomeType__
) -> Result<(), SettlementError>
``` 

Thus, the gadget registry not only needs to encode the inputs and name of the gadget, but it actually needs to define, or point to, the actual circuit that a consumer must satisfy in order to get a decryption key from the TEE based service. We approach another crossroads here as well: the current contract follows a register -> settle pattern using semaphore, with the TEE simply checking if 'isSettled = true' given some provided input params, however, I'm unsure if this is the proper approach. The alternative would be to let the TEE actually verify the correctness of the ZKP, but I don't think it's wise to remove the validation from the contract, else we lose a lot of useful state.

e.g. the current TEE code does

``` rust
async fn decrypt(
    State(s): State<Arc<AppState>>,
    Json(req): Json<DecryptReq>,
) -> Result<Json<DecryptRes>, (StatusCode, String)> {
    let resource_id = parse_b32(&req.resource_id).map_err(bad)?;
    let stealth = parse_addr(&req.stealth_address).map_err(bad)?;
    let ciphertext = B64
        .decode(req.ciphertext_b64.as_bytes())
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;

    let settled = s
        .settlement
        .is_settled(stealth, resource_id)
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;
    if !settled {
        return Err((StatusCode::FORBIDDEN, "not settled".into()));
    }

    let plaintext = crypto::unseal(&s.keypair.secret, &resource_id, &ciphertext)
        .map_err(|_| (StatusCode::BAD_REQUEST, "decryption failed".into()))?;

    Ok(Json(DecryptRes { plaintext_b64: B64.encode(&plaintext) }))
}
```

so maybe the TEE should actually verify the ZKP and submit an attestation on chain. However, I'm really not sure. Ultimately I aim to transition from a TEE to a threshiold encryption network later on.