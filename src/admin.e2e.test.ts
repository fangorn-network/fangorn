import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keccak256, parseEther, stringToBytes } from "viem";
import { APP_REGISTRY_ABI, PublisherStatus } from "./contracts/index.js";
import { cleanUp, skipFork, startFork, type Fork, type TestBed } from "./test/testbed.js";

// What the protocol admin can do to the network: take an app down, and ban a
// publisher everywhere. And what happens to an app whose subscription lapses,
// which needs the fork's clock.
//
// These need an admin, not THE admin. So they run against a local fork of the
// deployed contracts (anvil), where the admin role is handed to a key generated
// here. The real admin key, which can also upgrade the contracts, never has to
// be in a .env or a CI secret, and nothing on the real chain is ever suspended.
// Every wallet is generated and funded on the fork, and commits go straight to
// the AppRegistry rather than through storage, so the suite needs no secrets at all.
//
// Not covered, on purpose: fees, the USDC and registry pointers, and upgrades.
// The contracts repo covers them in its Foundry tests and upgrade rehearsals.

const ZERO_BYTES32 =
    "0x0000000000000000000000000000000000000000000000000000000000000000";

describe.skipIf(skipFork)("Fangorn protocol admin E2E (fork)", () => {
    const OWNER = 0;
    const GUEST = 1;
    const ADMIN = 2;
    let bed: TestBed;
    let chain: Fork["chain"];

    /**
     * Advance `namespace` for one wallet straight on the AppRegistry. That is
     * the gate these tests are about; going through the engine would only add an
     * upload in front of it.
     */
    async function commit(index: number, namespace: string) {
        const head = await bed.head(index, namespace);
        const next = keccak256(stringToBytes(`${namespace}-${String(Date.now())}`));
        return bed.getFangorn(index).getAppRegistry().commitStateRoot(namespace, head, next);
    }

    beforeAll(async () => {
        const fork = await startFork();
        chain = fork.chain;
        bed = fork.bed([await fork.wallet(), await fork.wallet(), await fork.wallet()]);
        const newAdmin = bed.getFangorn(ADMIN).getAddress();

        // Hand the AppRegistry's admin role to the generated key, as its current
        // admin. Only a fork lets us act as an account we hold no key for. Every
        // ban and takedown lives there; the DataRegistry's admin can only upgrade it.
        const address = fork.config.appRegistryContractAddress;
        const current = await chain.readContract({ address, abi: APP_REGISTRY_ABI, functionName: "admin" });
        await chain.impersonateAccount({ address: current });
        await chain.setBalance({ address: current, value: parseEther("1") });
        const hash = await chain.writeContract({
            account: current,
            address,
            abi: APP_REGISTRY_ABI,
            functionName: "setAdmin",
            args: [newAdmin],
        });
        await chain.waitForTransactionReceipt({ hash });
        await chain.stopImpersonatingAccount({ address: current });
        const now = await bed.getFangorn(ADMIN).getAppRegistry().admin();
        if (now.toLowerCase() !== newAdmin.toLowerCase()) {
            throw new Error(`the fork's admin is ${now}, not the generated ${newAdmin}`);
        }

        // ponytail: claiming is free while the subscription fee is 0. If it is
        // raised, mint the owner USDC on the fork (anvil_setStorageAt) here.
        // The guest is an ordinary member: invited, joined.
        await bed.registerApp(OWNER);
        await bed.invite(OWNER, GUEST);
        await bed.getFangorn(GUEST).getAppRegistry().joinApp();
    }, 180_000);

    afterAll(cleanUp);

    // The admin takedown, one level above an app owner suspending a publisher:
    // suspending the app stops everyone under it, its owner included.
    it("admin app suspension works", async () => {
        const admin = bed.getFangorn(ADMIN).getAppRegistry();
        const apps = bed.getFangorn(OWNER).getAppRegistry();
        const self = bed.getFangorn(OWNER).getAddress();
        const guest = bed.getFangorn(GUEST).getAddress();
        const namespace = `takedown-${String(Date.now())}`;

        expect(await apps.isAppSuspended()).toBe(false);
        expect(await apps.canPublish(self)).toBe(true);
        expect(await apps.canPublish(guest)).toBe(true);

        await admin.setAppSuspended(true);
        expect(await apps.isAppSuspended()).toBe(true);
        expect(await apps.canPublish(self)).toBe(false);
        expect(await apps.canPublish(guest)).toBe(false);

        // The membership underneath is untouched — this is a takedown, not an
        // eviction, which is what makes reinstating free for the publishers.
        const info = await apps.joinInfo(self);
        expect(info.appSuspended).toBe(true);
        expect(info.canPublish).toBe(false);
        expect(info.status).toBe(PublisherStatus.ACTIVE);
        expect(info.acceptedTerms).toBe(info.termsHash);

        // And a commit is refused, saying why.
        await expect(commit(OWNER, namespace)).rejects.toThrow(/AppSuspended/);
        await expect(commit(GUEST, namespace)).rejects.toThrow(/AppSuspended/);

        await admin.setAppSuspended(false);
        expect(await apps.isAppSuspended()).toBe(false);
        expect(await apps.canPublish(self)).toBe(true);
        expect(await apps.canPublish(guest)).toBe(true);

        // Reinstated means publishing again, not just reading as allowed.
        await commit(OWNER, namespace);
        expect(await bed.head(OWNER, namespace)).not.toBe(ZERO_BYTES32);
    }, 120_000);

    // The network-wide ban. It is on the wallet, not on one app: a suspended
    // publisher cannot commit anywhere, and cannot start over by claiming an app
    // of its own.
    it("admin publisher suspension works", async () => {
        const admin = bed.getFangorn(ADMIN).getAppRegistry();
        const guest = bed.getFangorn(GUEST);
        const apps = guest.getAppRegistry();
        const self = guest.getAddress();
        const stamp = String(Date.now());
        const namespace = `ban-${stamp}`;

        // In good standing, it publishes.
        await commit(GUEST, namespace);
        const head = await bed.head(GUEST, namespace);
        expect(head).not.toBe(ZERO_BYTES32);

        await admin.setGlobalSuspension(self, true);
        expect(await apps.isGloballySuspended(self)).toBe(true);

        await expect(commit(GUEST, namespace)).rejects.toThrow(/PublisherSuspendedGlobal/);

        const suiteApp = guest.getAppId();
        guest.setAppId(`banned-app-${stamp}`);
        try {
            await expect(
                apps.registerApp(keccak256(stringToBytes("terms")), "https://example.test/terms", 0n),
            ).rejects.toThrow(/PublisherSuspendedGlobal/);
        } finally {
            guest.setAppId(suiteApp);
        }

        // The ban is one wallet's: the app's owner still publishes.
        await commit(OWNER, namespace);

        // Lifting it restores the wallet where it stood: same head, and the next
        // commit builds on it.
        await admin.setGlobalSuspension(self, false);
        expect(await apps.isGloballySuspended(self)).toBe(false);
        expect(await bed.head(GUEST, namespace)).toBe(head);

        await commit(GUEST, namespace);
        expect(await bed.head(GUEST, namespace)).not.toBe(head);
    }, 120_000);

    // Last: it moves the fork's clock past the app's expiry. Expiry is enforced
    // on-chain with no grace period, and renewing restores everything at once.
    it("an expired app takes no commits until it is renewed", async () => {
        const apps = bed.getFangorn(OWNER).getAppRegistry();
        const guest = bed.getFangorn(GUEST).getAddress();
        const namespace = `expiry-${String(Date.now())}`;

        const expiresAt = await apps.expiresAt();
        const { timestamp } = await chain.getBlock();
        await chain.increaseTime({ seconds: Number(expiresAt - timestamp) });
        await chain.mine({ blocks: 1 });

        expect(await apps.canPublish(guest)).toBe(false);
        await expect(commit(OWNER, namespace)).rejects.toThrow(/SubscriptionExpired/);
        await expect(commit(GUEST, namespace)).rejects.toThrow(/SubscriptionExpired/);

        await apps.renewSubscription();
        expect(await apps.expiresAt()).toBeGreaterThan(expiresAt);
        expect(await apps.canPublish(guest)).toBe(true);
        await commit(GUEST, namespace);
        expect(await bed.head(GUEST, namespace)).not.toBe(ZERO_BYTES32);
    }, 120_000);
});
