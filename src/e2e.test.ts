    import { describe, it, expect, beforeAll } from "vitest";
import { type Hex, keccak256, stringToBytes, hexToBytes, bytesToHex } from "viem";
import { TestBed } from "./test/testbed.js";
import { sealSelf, unsealSelf, GADGET_SELF_HKDF_V1 } from "./crypto/encryption.js";

const PRIVATE_KEY = process.env.ETH_PRIVATE_KEY as Hex;
const PARTY_TWO_KEY = process.env.SECOND_ETH_PRIVATE_KEY as Hex;
const PARTY_THREE_KEY = process.env.THIRD_ETH_PRIVATE_KEY as Hex;

const PINATA_JWT = process.env.PINATA_JWT ?? "";
const PINATA_GATEWAY = process.env.PINATA_GATEWAY ?? "https://gateway.pinata.cloud";
// const RPC_URL = process.env.RPC_URL ?? "https://sepolia-rollup.arbitrum.io/rpc";
// const REGISTRY_ADDRESS = process.env.DATA_SOURCE_REGISTRY_ADDRESS as Hex;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ZERO_BYTES32 =
    "0x0000000000000000000000000000000000000000000000000000000000000000";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

interface TestPayload {
    event: string;
    timestamp: number;
    status: string;		
}

describe("Fangorn True E2E: Storage + Chain Anchor", () => {
    let testbed: TestBed;

    beforeAll(() =>   {
        testbed = TestBed.init([PRIVATE_KEY]);
    });

    it("single uploader mutates its namespace state root properly", async () => {

        // No reset needed: each test uses a fresh namespace, and every namespace
        // starts from its own zero head rather than sharing the publisher's.

        // Two independent registrations: the app claims its namespace prefix,
        // the publisher earns the right to write. Both idempotent.
        await testbed.registerApp(0)
        await testbed.register(0)
        console.log('publisher registration success')
        // initialize a new namespace/repo
        const namespace = `test-${Date.now()}`
        await testbed.initRepo(0, namespace)
        console.log('namespace initialized')
        // input data
        const name = `test-data`
        const payload: TestPayload = {
            event: "E2E Test Run",
            timestamp: Date.now(),
            status: "active"
        };

        // f_list[0].upload(payload, name)
        console.log('upload begin')
        const res = await testbed.upload(0, namespace, payload, name);
        expect(res.txHash).toBeTruthy();

        // wait for pinata
        await sleep(5000)
        // fetch data
        const retrieved = await testbed.fetch(0, res.payloadCid, namespace);
        expect(retrieved).toBeDefined();
        expect(retrieved.payload.event).toBe("E2E Test Run");
        expect(retrieved.payload.status).toBe("active");
        expect(typeof retrieved.payload.timestamp).toBe("number");

        // and then we can upload a second item and fetch BOTH
        const name2 = `test-data-2`
        const payload2: TestPayload = {
            event: "E2E Test Run 2",
            timestamp: Date.now(),
            status: "active"
        };
        const res2 = await testbed.upload(0, namespace, payload2, name2);
        const retrieved2 = await testbed.fetch(0, res2.payloadCid, namespace);
        expect(retrieved2).toBeDefined();
        expect(retrieved2.payload.event).toBe("E2E Test Run 2");
        expect(retrieved2.payload.status).toBe("active");
        expect(typeof retrieved2.payload.timestamp).toBe("number");

        // inspecting the namespace should show both vertices we just committed
        const contents = await testbed.inspect(0, namespace);
        expect(contents.vertices).toHaveLength(2);
        expect(contents.vertices.map(v => v.cid).sort()).toEqual(
            [res.payloadCid, res2.payloadCid].sort()
        );
        expect(contents.vertices.map(v => v.payload.event).sort()).toEqual(
            ["E2E Test Run", "E2E Test Run 2"].sort()
        );
    }, 120_000);

    // The two registrations are genuinely independent, and an app is not
    // optional: a fully-registered publisher still cannot write under an app id
    // nobody has claimed. This is what makes an app's namespace prefix its own —
    // publishing into it requires that someone registered it first.
    it("rejects a registered publisher writing to an unregistered app", async () => {
        await testbed.register(0); // publisher rights, no app claimed

        const orphan = TestBed.init([PRIVATE_KEY], `unclaimed-${Date.now()}`);
        expect(await orphan.appOwner(0)).toBe(ZERO_ADDRESS);

        await expect(
            orphan.initRepo(0, `ns-${Date.now()}`),
        ).rejects.toThrow(/AppNotFound|revert/i);
    }, 120_000);

    // Each `app:publisher:namespace` triple is its own on-chain timeline, so one
    // publisher's namespaces advance independently and each namespace's `inspect`
    // sees only its own vertices (no cross-talk).
    it("supports multiple namespaces under a single publisher, isolated from each other", async () => {
        // Register the app and the publisher (both idempotent). Each run uses
        // fresh, uniquely-named namespaces, each starting from its own zero head.
        await testbed.registerApp(0);
        await testbed.register(0);

        const stamp = Date.now();
        const nsA = `alpha-${stamp}`;
        const nsB = `beta-${stamp}`;

        await testbed.initRepo(0, nsA);
        await testbed.initRepo(0, nsB);

        // Interleave uploads across the two namespaces on the same publisher.
        const a1 = await testbed.upload(0, nsA, { event: "A1", timestamp: Date.now(), status: "active" }, "a1");
        const b1 = await testbed.upload(0, nsB, { event: "B1", timestamp: Date.now(), status: "active" }, "b1");
        const a2 = await testbed.upload(0, nsA, { event: "A2", timestamp: Date.now(), status: "active" }, "a2");

        expect(a1.txHash).toBeTruthy();
        expect(b1.txHash).toBeTruthy();
        expect(a2.txHash).toBeTruthy();

        // Each namespace resolves from its own on-chain head and must return only
        // its own vertices — the whole point of per-namespace timelines.
        const contentsA = await testbed.inspect(0, nsA);
        const contentsB = await testbed.inspect(0, nsB);

        expect(contentsA.vertices.map(v => v.cid).sort()).toEqual([a1.payloadCid, a2.payloadCid].sort());
        expect(contentsA.vertices.map(v => v.payload.event).sort()).toEqual(["A1", "A2"]);

        expect(contentsB.vertices.map(v => v.cid).sort()).toEqual([b1.payloadCid]);
        expect(contentsB.vertices.map(v => v.payload.event)).toEqual(["B1"]);

        // No leakage in either direction.
        const aCids = new Set(contentsA.vertices.map(v => v.cid));
        expect(contentsB.vertices.some(v => aCids.has(v.cid))).toBe(false);
    }, 180_000);

    // The on-chain shape of per-namespace timelines, asserted against the heads
    // themselves rather than inferred from the contents.
    //
    // Under the old flat model both namespaces compare-and-swapped ONE root per
    // publisher: pushing to B moved the same slot A had just moved, so A's head
    // could not survive B's push and B's CAS had to build on A's root. Here each
    // head advances alone and an untouched namespace stays at zero.
    //
    // Deliberately sequential: both pushes come from one wallet, so issuing them
    // concurrently contends on the account nonce, not on the contract's CAS —
    // that would test viem's nonce handling, not this change. The contract-level
    // concurrency guarantee is covered by `test_subspaces_have_isolated_timelines`.
    it("advances each namespace's on-chain head independently", async () => {
        await testbed.registerApp(0);
        await testbed.register(0);

        const stamp = Date.now();
        const nsA = `head-a-${stamp}`;
        const nsB = `head-b-${stamp}`;
        const untouched = `head-none-${stamp}`;

        await testbed.initRepo(0, nsA);
        const headA = await testbed.head(0, nsA);
        expect(headA).not.toBe(ZERO_BYTES32);

        // Pushing B must not disturb A — the old model could not do this.
        await testbed.initRepo(0, nsB);
        const headB = await testbed.head(0, nsB);
        expect(headB).not.toBe(ZERO_BYTES32);
        expect(headB).not.toBe(headA);
        expect(await testbed.head(0, nsA)).toBe(headA);

        // A namespace nobody has written to has its own zero head, rather than
        // inheriting whatever the publisher last committed anywhere.
        expect(await testbed.head(0, untouched)).toBe(ZERO_BYTES32);

        // And a second push to A advances only A.
        await testbed.upload(0, nsA, { event: "A2", timestamp: Date.now(), status: "active" }, "a2");
        expect(await testbed.head(0, nsA)).not.toBe(headA);
        expect(await testbed.head(0, nsB)).toBe(headB);
    }, 180_000);

    // Batch publishing: many vertices (and edges) committed to one namespace in a
    // SINGLE on-chain commit, rather than one tx per vertex. This is the realistic
    // "publish a dataset" path and the one most exposed to the pail commit
    // overflow at scale (see src/engine/publish-overflow.test.ts) — here we keep
    // the batch modest so it settles quickly while still exercising the path.
    it("publishes a batch of vertices to one namespace in a single commit", async () => {
        await testbed.registerApp(0);
        await testbed.register(0);

        const namespace = `batch-${Date.now()}`;
        await testbed.initRepo(0, namespace);

        const COUNT = 25;
        const vertices = Array.from({ length: COUNT }, (_, i) => ({
            id: `v-${i}`,
            tag: "record",
            payload: { event: `batch-item-${i}`, timestamp: Date.now(), status: "active" },
        }));

        const res = await testbed.uploadBatch(0, namespace, vertices);
        expect(res.txHash).toBeTruthy();
        expect(Object.keys(res.vertexCids)).toHaveLength(COUNT);

        const contents = await testbed.inspect(0, namespace);
        expect(contents.vertices).toHaveLength(COUNT);
        expect(contents.vertices.map(v => v.payload.event).sort()).toEqual(
            vertices.map(v => v.payload.event).sort(),
        );
    }, 180_000);

    // Purely-private (self-hkdf-v1) end-to-end. Encryption/decryption is entirely
    // OUT OF BAND — pre/post-ingestion. Fangorn never sees plaintext or a key: it
    // ingests opaque ciphertext bytes like any other payload (IPFS/Pinata doesn't
    // care that the bytes are a ciphertext). No R2, no access worker, no settlement
    // — that machinery is only for the gated worker-usdc-v1 gadget.
    it("purely private: encrypt for self, ingest, retrieve, decrypt", async () => {
        await testbed.registerApp(0);
        await testbed.register(0);
        const namespace = `private-${Date.now()}`;
        await testbed.initRepo(0, namespace);

        // The single party's own secret == its own key. Bound to a resourceId so
        // the same key can't cross-open a different resource.
        const ownSecret = hexToBytes(PRIVATE_KEY);
        const name = "secret-msg";
        const resourceId = keccak256(stringToBytes(`${namespace}:${name}`));
        const message = "the eagles are coming";

        // --- out of band, pre-ingestion: encrypt for the single party ---
        const ciphertext = sealSelf(
            new TextEncoder().encode(message),
            ownSecret,
            resourceId,
        );

        // --- ingest opaque ciphertext to fangorn like any other payload ---
        const res = await testbed.upload(
            0,
            namespace,
            {
                gadget: GADGET_SELF_HKDF_V1,
                resourceId,
                ciphertext: bytesToHex(ciphertext),
            },
            name,
        );
        expect(res.txHash).toBeTruthy();

        // --- retrieve: still opaque ciphertext ---
        const retrieved = await testbed.fetch(0, res.payloadCid, namespace);
        const stored = retrieved.payload as {
            gadget: string;
            resourceId: Hex;
            ciphertext: Hex;
        };
        expect(stored.gadget).toBe(GADGET_SELF_HKDF_V1);
        expect(stored.ciphertext).toBe(bytesToHex(ciphertext));

        // --- out of band, post-retrieval: decrypt with the party's own key ---
        const plaintext = unsealSelf(
            hexToBytes(stored.ciphertext),
            ownSecret,
            stored.resourceId,
        );
        expect(new TextDecoder().decode(plaintext)).toBe(message);

        // a party without the key cannot open it
        const wrongSecret = new Uint8Array(32).fill(0xab);
        expect(() =>
            unsealSelf(hexToBytes(stored.ciphertext), wrongSecret, resourceId),
        ).toThrow();
    }, 120_000);

    // it("multiparty uploads mutate global state root properly", async () => {
    //     const registry = fangorn.getDataRegistry();
    //     const storage = fangorn.getStorage();

    //     // check onchain registration
    //     const isRegistered = await registry.isRegistered(accountAddress);
    //     if (!isRegistered) {
    //         console.log("Registering publisher on-chain...");
    //         await registry.register();
    //     }

    //     const initialHead = await registry.getNamespaceHead(accountAddress);
    //     console.log(`Current authoritative on-chain head: ${initialHead}`);

    //     // input data
    //     const payload: TestPayload = {
    //         event: "E2E Test Run",
    //         timestamp: Date.now(),
    //         status: "active"
    //     };

    //     // pin to pinata
    //     console.log("Uploading payload structure directly to storage backend...");
    //     const cid = await storage.put(payload, { name: `e2e_${Date.now()}` });
    //     console.log(`Successfully pinned data. Real IPFS CID generated: ${cid}`);

    //     // derive state root and convert the CID to Hex
    //     const root1 = keccak256(stringToBytes(cid));
    //     console.log(`Derived contract state root from CID: ${root1}`);

    //     // commit onchain
    //     console.log(`Anchoring root ${root1} on-chain via DataRegistry contract...`);
    //     const txHash = await registry.commitStateRoot(initialHead, root1);
    //     expect(txHash).toBeTruthy();

    //     // verify head was updated
    //     const updatedHead = await registry.getNamespaceHead(accountAddress);
    //     expect(updatedHead.toLowerCase()).toBe(root1.toLowerCase());

    //     // fetch data
    //     console.log(`Fetching back data array using the real CID reference...`);
    //     const retrieved = await storage.get<TestPayload>(cid);

    //     expect(retrieved).toBeDefined();
    //     expect(retrieved.event).toBe("E2E Test Run");
    //     expect(retrieved.status).toBe("active");
    //     expect(typeof retrieved.timestamp).toBe("number");

    //     console.log("E2E Success: Storage pipeline and contract state root transitions are fully synchronized.");
    // }, 120_000);


});