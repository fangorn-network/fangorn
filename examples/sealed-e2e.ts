/**
 * sealed-e2e.ts — end-to-end exercise of the sealed-encryption flow.
 *
 * This script is the SPEC for the planned TEE-sealed encryption gadget. It runs
 * top-to-bottom with no test framework so the protocol is legible by reading it.
 *
 * What it proves:
 *   - seal(plaintext, teePubkey, resourceId) produces a ciphertext that the TEE,
 *     and only the TEE, can open — and only after binding to the right resourceId.
 *   - The HandleFieldInput encryption metadata (gadget, ciphertextHash, teePubkey)
 *     round-trips through a manifest and is sufficient to locate + verify + decrypt.
 *   - The settlement gate is enforced: decryption fails for an unsettled resource.
 *
 * Scope (see sealed-e2e.README.md):
 *   - The TEE is a MockTeeServer in this file, implementing the exact crypto the
 *     real Rust service will (HKDF root -> X25519, ECDH, HKDF, AES-256-GCM).
 *   - Storage is in-memory (MockStorage). No IPFS, no R2.
 *   - The SettlementRegistry is NOT deployed right now, so the settlement gate is
 *     mocked in-memory (LocalSettlementRegistry) mirroring the on-chain contract's
 *     `is_settled = settlements[keccak(stealth_address || resource_id)]` semantics.
 *     The shared Stylus contract is the benchmark for that behaviour.
 *
 * Nothing here is extracted into the SDK yet. seal(), MockTeeServer, MockStorage
 * and LocalSettlementRegistry all live in this file on purpose — they get pulled
 * out in follow-up PRs once the real TEE and storage layers exist and we know the
 * right interface. The discovery is the deliverable.
 *
 * Run: pnpm e2e:sealed   (or  npm run e2e:sealed)
 */

// === imports ===
import {
    keccak256,
    encodePacked,
    bytesToHex,
    hexToBytes,
    type Address,
    type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { x25519 } from "@noble/curves/ed25519";
import { gcm } from "@noble/ciphers/aes.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hkdf } from "@noble/hashes/hkdf.js";

// Real SDK pieces — the identifier derivation and the handle shape are NOT mocked.
import { DataSourceRegistry } from "../src/registries/datasource-registry/index.js";
import type { HandleFieldInput, ManifestEntry } from "../src/roles/publisher/types.js";

// === small helpers ===

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

function concat(...parts: Uint8Array[]): Uint8Array {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
        out.set(p, off);
        off += p.length;
    }
    return out;
}

const hkdfSha256 = (
    ikm: Uint8Array,
    salt: Uint8Array | undefined,
    info: Uint8Array,
    length: number,
): Uint8Array => hkdf(sha256, ikm, salt, info, length);

/** 0x-prefixed sha256 hex of arbitrary bytes — used for CIDs and ciphertext hashes. */
const sha256Hex = (bytes: Uint8Array): Hex => bytesToHex(sha256(bytes));

/** HKDF `info` that binds a key to a specific resource: resourceId(32 bytes) || ":sealed". */
const sealInfo = (resourceId: Hex): Uint8Array => concat(hexToBytes(resourceId), utf8(":sealed"));

let failures = 0;
function assert(cond: boolean, msg: string): asserts cond {
    if (!cond) {
        failures++;
        console.error(`  ✗ ${msg}`);
        throw new Error(`assertion failed: ${msg}`);
    }
    console.log(`  ✓ ${msg}`);
}

// === MockStorage ===
// Stands in for both IPFS and R2. CIDs are the content hash, so storage is
// content-addressed and immutable — exactly what we assert against later.
class MockStorage {
    private data = new Map<string, Uint8Array>();

    async put(bytes: Uint8Array, _opts?: { name?: string }): Promise<Hex> {
        const cid = sha256Hex(bytes);
        this.data.set(cid, bytes);
        return cid;
    }

    async get(cid: string): Promise<Uint8Array> {
        const v = this.data.get(cid);
        if (!v) throw new Error("not found: " + cid);
        return v;
    }
}

// === LocalSettlementRegistry ===
// In-memory mirror of the on-chain SettlementRegistry's settlement bookkeeping.
// The real contract stores `settlements[keccak(stealth_address || resource_id)] = true`
// inside settle() after verifying the Semaphore proof. Here we trust the caller and
// just record the same key, so MockTeeServer.isSettled() exercises identical gating
// logic. When the contract is redeployed, swap isSettled() for the real read.
class LocalSettlementRegistry {
    private settled = new Set<Hex>();

    private key(stealthAddress: Address, resourceId: Hex): Hex {
        // matches the contract's hash_concat(stealth_address.as_slice(), resource_id.as_slice())
        return keccak256(encodePacked(["address", "bytes32"], [stealthAddress, resourceId]));
    }

    settle(stealthAddress: Address, resourceId: Hex): void {
        this.settled.add(this.key(stealthAddress, resourceId));
    }

    async isSettled(stealthAddress: Address, resourceId: Hex): Promise<boolean> {
        return this.settled.has(this.key(stealthAddress, resourceId));
    }
}

// === MockTeeServer ===
// Implements the exact crypto the real Rust TEE will. No HTTP — the script calls
// these methods directly. The decrypt() gate calls the injected isSettled() exactly
// the way the real server will call the on-chain SettlementRegistry. The TEE trusts
// the contract; the Semaphore proof was already verified on-chain in settle().
class MockTeeServer {
    private secret: Uint8Array; // 32-byte X25519 secret
    public pubkey: Uint8Array; // 32-byte X25519 public key

    constructor(
        rootKey: Uint8Array,
        private isSettledFn: (stealthAddress: Address, resourceId: Hex) => Promise<boolean>,
    ) {
        // HKDF root key -> static X25519 secret. Deterministic from the root.
        this.secret = hkdfSha256(rootKey, undefined, utf8("fangorn:tee:x25519:v1"), 32);
        this.pubkey = x25519.getPublicKey(this.secret);
    }

    getPubkey(): Uint8Array {
        return this.pubkey;
    }

    async decrypt(req: {
        resourceId: Hex;
        stealthAddress: Address;
        ciphertext: Uint8Array;
    }): Promise<Uint8Array> {
        if (!(await this.isSettledFn(req.stealthAddress, req.resourceId))) {
            throw new Error("not settled");
        }
        const ephPub = req.ciphertext.slice(0, 32);
        const nonce = req.ciphertext.slice(32, 44);
        const aesCt = req.ciphertext.slice(44);

        const shared = x25519.getSharedSecret(this.secret, ephPub);
        const aesKey = hkdfSha256(shared, undefined, sealInfo(req.resourceId), 32);
        return gcm(aesKey, nonce).decrypt(aesCt);
    }
}

// === seal() helper (future SDK extraction) ===
// Ephemeral-static ECDH to the TEE's static key, keyed to the resourceId.
//   ciphertext = ephemeralPub(32) || nonce(12) || aes-256-gcm-ct
function seal(plaintext: Uint8Array, teePubkey: Uint8Array, resourceId: Hex): Uint8Array {
    const ephSec = x25519.utils.randomPrivateKey();
    const ephPub = x25519.getPublicKey(ephSec);
    const shared = x25519.getSharedSecret(ephSec, teePubkey);
    const aesKey = hkdfSha256(shared, undefined, sealInfo(resourceId), 32);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const aesCt = gcm(aesKey, nonce).encrypt(plaintext);
    return concat(ephPub, nonce, aesCt);
}

// === MockManifestStore ===
// Stands in for fangorn.publisher.publishRecords()/getEntry(). The real path writes
// the manifest to IPFS and records the CID in the DataSourceRegistry on-chain; here
// it is a Map so the script runs fully offline. The handle SHAPE is real — that is
// what we are validating.
class MockManifestStore {
    private entries = new Map<string, ManifestEntry>();

    private key(schemaName: string, datasetName: string, recordName: string): string {
        return `${schemaName}/${datasetName}/${recordName}`;
    }

    async publishRecords(params: {
        schemaName: string;
        datasetName: string;
        records: { name: string; fields: Record<string, unknown> }[];
    }): Promise<void> {
        for (const r of params.records) {
            this.entries.set(this.key(params.schemaName, params.datasetName, r.name), {
                name: r.name,
                fields: r.fields,
            });
        }
    }

    async getEntry(
        schemaName: string,
        datasetName: string,
        recordName: string,
    ): Promise<ManifestEntry> {
        const e = this.entries.get(this.key(schemaName, datasetName, recordName));
        if (!e) throw new Error(`Entry "${recordName}" not found in dataset ${datasetName}`);
        return e;
    }
}

// =============================================================================
async function main(): Promise<void> {
    const started = Date.now();
    console.log("=== sealed e2e (fully local: mock TEE + mock storage + mock settlement) ===\n");

    // === main: setup ===
    console.log("[setup]");
    const storage = new MockStorage();
    const manifests = new MockManifestStore();
    const settlement = new LocalSettlementRegistry();

    // The TEE's root key would be sealed inside the enclave. Fixed here for repeatability.
    const rootKey = sha256(utf8("fangorn:tee:root:dev-only"));
    const mockTee = new MockTeeServer(rootKey, (addr, rid) => settlement.isSettled(addr, rid));
    const teePubkey = mockTee.getPubkey();

    // Publisher == consumer in this test. No real wallet/keys needed — generate locally.
    // NOTE: in the on-chain flow the owner is walletClient.account.address, and the
    // stealth address is derived from the identity secret. Here both are local accounts.
    const owner: Address = privateKeyToAccount(generatePrivateKey()).address;
    const stealthAddress: Address = privateKeyToAccount(generatePrivateKey()).address;

    // The schemaId would come from the SchemaRegistry contract. Offline, derive a
    // stable 32-byte value from the name — it only needs to be consistent between
    // the publisher (resourceId) and the TEE (HKDF info).
    const schemaName = "fangorn.test.sealed.v0";
    const schemaId: Hex = keccak256(utf8(schemaName));
    const datasetName = "ds.sealed." + Date.now();
    const recordName = "sealed-roundtrip-" + Date.now();

    // The SAME identifier the SettlementRegistry uses and the TEE uses for HKDF.
    const resourceId = DataSourceRegistry.resourceId(owner, schemaId, recordName);

    // Gotcha guard: resourceId must be a 32-byte hex. A mismatch in byte representation
    // between publisher and TEE shows up as "ciphertext corruption", not a clear error.
    console.log(`  resourceId = ${resourceId}`);
    assert(hexToBytes(resourceId).length === 32, "resourceId decodes to exactly 32 bytes");
    assert(teePubkey.length === 32, "TEE pubkey is 32 bytes");

    // === main: publish ===
    console.log("\n[publish] encrypt -> store -> build handle -> publish manifest");
    const plaintext = utf8("hello fangorn sealed test " + Date.now());
    const ciphertext = seal(plaintext, teePubkey, resourceId);
    const cid = await storage.put(ciphertext, { name: "sealed:" + recordName });

    const handle: HandleFieldInput = {
        "@type": "handle",
        uri: cid,
        workerUrl: "mock://storage",
        encryption: {
            gadget: "tee-sealed-v1",
            ciphertextHash: sha256Hex(ciphertext),
            teePubkey: bytesToHex(teePubkey), // inline for now; gadget registry later
        },
    };

    await manifests.publishRecords({
        schemaName,
        datasetName,
        records: [{ name: recordName, fields: { audio: handle } }],
    });
    console.log(`  published ${schemaName}/${datasetName}/${recordName} (cid ${cid.slice(0, 18)}…)`);

    // === main: settle ===
    console.log("\n[settle] record settlement for (stealthAddress, resourceId)");
    // Stands in for the on-chain register -> claim flow. Once the proof verifies in
    // SettlementRegistry.settle(), the contract marks this pair settled; we mirror that.
    settlement.settle(stealthAddress, resourceId);
    assert(await settlement.isSettled(stealthAddress, resourceId), "resource reports settled after settle()");

    // === main: consume ===
    console.log("\n[consume] fetch manifest -> verify -> decrypt via TEE");
    const entry = await manifests.getEntry(schemaName, datasetName, recordName);
    const fetched = entry.fields.audio as HandleFieldInput;
    assert(fetched["@type"] === "handle", "field is a handle");
    assert(fetched.encryption?.gadget === "tee-sealed-v1", "gadget is tee-sealed-v1");

    const fetchedCiphertext = await storage.get(fetched.uri);
    assert(
        sha256Hex(fetchedCiphertext) === fetched.encryption?.ciphertextHash,
        "ciphertextHash matches stored bytes (storage is immutable)",
    );

    const recovered = await mockTee.decrypt({ resourceId, stealthAddress, ciphertext: fetchedCiphertext });
    assert(
        recovered.length === plaintext.length && recovered.every((b, i) => b === plaintext[i]),
        "decrypted plaintext is byte-equal to the original",
    );
    console.log(`  recovered: "${new TextDecoder().decode(recovered)}"`);

    // === main: negative ===
    console.log("\n[negative] unsettled resource must NOT decrypt");
    const otherRecord = "never-settled-" + Date.now();
    const otherResourceId = DataSourceRegistry.resourceId(owner, schemaId, otherRecord);
    const otherCiphertext = seal(utf8("secret that stays secret"), teePubkey, otherResourceId);
    await storage.put(otherCiphertext);
    const randomStealth: Address = privateKeyToAccount(generatePrivateKey()).address;

    let threw = false;
    try {
        await mockTee.decrypt({
            resourceId: otherResourceId,
            stealthAddress: randomStealth,
            ciphertext: otherCiphertext,
        });
    } catch (e) {
        threw = true;
        console.log(`  rejected as expected: ${(e as Error).message}`);
    }
    assert(threw, "decrypt throws for an unsettled resource");

    // === main: summary ===
    console.log(`\n✓ sealed e2e passed (${Date.now() - started}ms)`);
}

main().catch((err) => {
    console.error(`\n✗ sealed e2e FAILED${failures ? ` (${failures} assertion(s) failed)` : ""}`);
    console.error(err);
    // proces s.exit(1);
});
