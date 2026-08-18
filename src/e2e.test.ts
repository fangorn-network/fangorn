import { describe, it, expect, beforeAll } from "vitest";
import { type Hex, keccak256, stringToBytes, hexToBytes, bytesToHex } from "viem";
import { TestBed } from "./test/testbed.js";
import { needsReacceptance, packResourceUri, resourceIdOf } from "./contracts/index.js";
import { sealSelf, unsealSelf, GADGET_SELF_HKDF_V1 } from "./crypto/encryption.js";

const PRIVATE_KEY = process.env.ETH_PRIVATE_KEY as Hex;
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

describe("Fangorn E2E", () => {
    let testbed: TestBed;

    beforeAll(() => {
        testbed = TestBed.init([PRIVATE_KEY]);
    });

    it("single uploader mutates its namespace state root properly", async () => {
        // register a fresh app
        await testbed.registerApp(0)

        // register a publisher (TODO: should we register per-app? Do we need a publisher permissions map or something?)
        await testbed.register(0)
        console.log('publisher registration success')
        // initialize a new namespace
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

    // publishers must be registered onchain as publishers in order to write to an app
    // QQ: What if we used UCAN here?
    it("rejects a registered publisher writing to an unregistered app", async () => {
        await testbed.register(0); // publisher rights, no app claimed

        const orphan = TestBed.init([PRIVATE_KEY], `unclaimed-${Date.now()}`);
        expect(await orphan.appOwner(0)).toBe(ZERO_ADDRESS);

        await expect(
            orphan.initRepo(0, `ns-${Date.now()}`),
        ).rejects.toThrow(/AppNotFound|revert/i);
    }, 120_000);

    // publishers can independently write to multiple different namespaces in isolation
    it("supports multiple namespaces under a single publisher", async () => {
        // registration
        await testbed.registerApp(0);
        await testbed.register(0);

        const stamp = Date.now();
        const nsA = `alpha-${stamp}`;
        const nsB = `beta-${stamp}`;

        await testbed.initRepo(0, nsA);
        await testbed.initRepo(0, nsB);

        // uploads: a1, a2 => ns A
        //          b1     => ns B
        const a1 = await testbed.upload(0, nsA, { event: "A1", timestamp: Date.now(), status: "active" }, "a1");
        const b1 = await testbed.upload(0, nsB, { event: "B1", timestamp: Date.now(), status: "active" }, "b1");
        const a2 = await testbed.upload(0, nsA, { event: "A2", timestamp: Date.now(), status: "active" }, "a2");

        expect(a1.txHash).toBeTruthy();
        expect(b1.txHash).toBeTruthy();
        expect(a2.txHash).toBeTruthy();

        // Each namespace resolves from its own on-chain head and must return only its own vertices
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

describe("Fangorn registries E2E", () => {
    let testbed: TestBed;

    beforeAll(() => {
        testbed = TestBed.init([PRIVATE_KEY]);
    });

    // The four contracts are deployed independently and point at each other by
    // address. A redeploy that updates one address and not the others is silent
    // until a commit reverts NotRegisteredForApp, or a subscription reports a
    // publisher unregistered who plainly is. Asserting the pointers here is the
    // cheapest place to catch a half-finished deploy.
    it("the four registries point at each other", async () => {
        const f = testbed.getFangorn(0);
        const data = f.getDataRegistry();
        const apps = f.getAppRegistry();
        const subs = f.getSubscriptionRegistry();
        const settlement = f.getSettlementRegistry();

        expect((await data.appRegistry()).toLowerCase()).toBe(
            apps.getAddress().toLowerCase(),
        );
        expect((await subs.dataRegistry()).toLowerCase()).toBe(
            data.getAddress().toLowerCase(),
        );
        // Both paywalls settle in the same token, or a price quoted by one means
        // nothing to the other.
        expect((await subs.usdc()).toLowerCase()).toBe(
            (await settlement.getUsdc()).toLowerCase(),
        );

        // setAppId moves the app-scoped clients together and leaves the two
        // per-wallet ones alone (CO-1).
        const before = f.getAppId();
        f.setAppId("some-other-app");
        expect(apps.getAppId()).toBe(f.getAppId());
        expect(data.getAppId()).toBe(f.getAppId());
        f.setAppId(before);
    }, 60_000);

    // Publishing under an app is gated on membership of that app: the
    // DataRegistry cross-calls isRegisteredForApp inside commitStateRoot.
    it("app membership is what lets a publisher commit", async () => {
        await testbed.registerApp(0);
        await testbed.register(0);

        const f = testbed.getFangorn(0);
        const apps = f.getAppRegistry();
        const self = f.getAddress();

        const info = await apps.joinInfo(self);
        expect(info.termsHash).not.toBe(ZERO_BYTES32);
        expect(info.registered).toBe(true);
        expect(info.acceptedTerms).toBe(info.termsHash);
        expect(needsReacceptance(info)).toBe(false);
        expect(await apps.isRegisteredForApp(self)).toBe(true);

        // And a commit under the app now lands, which is the only proof that the
        // membership the AppRegistry reports is the one the DataRegistry reads.
        const namespace = `member-${Date.now()}`;
        await testbed.initRepo(0, namespace);
        const res = await testbed.upload(0, namespace, { ok: true }, "gated");
        expect(res.txHash).toBeTruthy();
    }, 180_000);

    // A wallet that never joined the app is not a member, and the app it did not
    // join reports so without throwing — an unclaimed app id is a legitimate read.
    it("a stranger is not a member, and an unclaimed app has no owner", async () => {
        const f = testbed.getFangorn(0);
        const apps = f.getAppRegistry();

        const stranger = "0x000000000000000000000000000000000000dEaD" as const;
        expect(await apps.isRegisteredForApp(stranger)).toBe(false);

        const before = f.getAppId();
        f.setAppId(`unclaimed-${Date.now()}`);
        expect(await apps.getAppOwner()).toBe(ZERO_ADDRESS);
        // No terms means no join is possible, and the client says so before
        // spending gas on a TermsNotSet revert (PUB-4).
        await expect(apps.registerForApp()).rejects.toThrow(/no terms/i);
        f.setAppId(before);
    }, 60_000);

    // The publisher-side storage paywall. The fee is pulled in USDC, so a
    // non-zero fee needs an ERC-20 approve first; at fee 0 this is a plain write.
    it("subscribing stamps the publisher's paid-at", async () => {
        await testbed.register(0);

        const f = testbed.getFangorn(0);
        const subs = f.getSubscriptionRegistry();
        const self = f.getAddress();

        const fee = await subs.subscriptionFee();
        if (fee > 0n) {
            console.log(`subscription fee is ${fee}; skipping (needs a USDC approve)`);
            return;
        }

        await subs.subscribe();

        const access = await subs.access(self);
        expect(access.registered).toBe(true);
        expect(access.paidAt).toBeGreaterThan(0n);
        expect(await subs.subscribedAt(self)).toBe(access.paidAt);

        // The active window is the gate's policy, not chain state: the same
        // paidAt is active under a wide window and expired under a zero one.
        expect(await subs.isActiveAt(self, 30n * 24n * 3600n)).toBe(true);
        expect(await subs.isActiveAt(self, 0n)).toBe(false);
    }, 180_000);

    // The consumer rail, publisher half. register/settle need an EIP-3009
    // authorization and a Semaphore proof and are not exercised here; listing,
    // pricing and delisting are, because those are what a publisher does.
    it("listing a resource makes it readable and delistable", async () => {
        const f = testbed.getFangorn(0);
        const settlement = f.getSettlementRegistry();
        const self = f.getAddress();

        const uid = keccak256(stringToBytes(`e2e-resource-${Date.now()}`));
        const price = 1_000n; // 0.001 USDC — 6 decimals, not wei
        // The uri is not free-form: `@fangorn-network/fetch` splits it on "#" and
        // verifies the bytes it decrypts against the hash half.
        const plaintextHash = keccak256(stringToBytes("pretend-plaintext"));
        const uri = packResourceUri("https://worker.example", plaintextHash);

        // The id is derivable before the transaction lands, and the local
        // derivation must equal the contract's — this is the one constant the
        // publisher (this SDK) and the buyer (@fangorn-network/fetch, which
        // derives it offline and never asks the chain) have to agree on. A
        // mismatch means buyers pay for an id no publisher ever listed.
        const resourceId = await settlement.resourceIdFor(self, uid);
        expect(resourceId).not.toBe(ZERO_BYTES32);
        expect(resourceIdOf(self, uid)).toBe(resourceId);

        await settlement.createResource(uid, price, uri);

        const resource = await settlement.getResource(resourceId);
        expect(resource.owner.toLowerCase()).toBe(self.toLowerCase());
        expect(resource.price).toBe(price);
        expect(resource.uri).toBe(uri);
        // Round-trips through the buyer's unpackUri: `${workerUrl}#${hash}`.
        expect(resource.uri.split("#")).toEqual(["https://worker.example", plaintextHash]);
        expect(resource.disabled).toBe(false);
        expect(resource.groupId).toBeGreaterThan(0n);

        // Access is checked against the reader's stealth address, and nobody has
        // settled for this one.
        expect(await settlement.isSettled(self, resourceId)).toBe(false);

        // Delisting blocks new registrations; it does not revoke what was paid for.
        await settlement.setDisabled(resourceId, true);
        expect(await settlement.isDisabled(resourceId)).toBe(true);

        // An unlisted resource reads as a zero owner rather than throwing —
        // getPrice alone cannot tell "free" from "does not exist".
        const missing = await settlement.getResource(keccak256(stringToBytes("nope")));
        expect(missing.owner).toBe(ZERO_ADDRESS);
    }, 240_000);
});
