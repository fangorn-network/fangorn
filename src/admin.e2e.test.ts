import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    type Address,
    createTestClient,
    http,
    keccak256,
    parseAbi,
    parseEther,
    publicActions,
    stringToBytes,
    walletActions,
} from "viem";
import { generatePrivateKey } from "viem/accounts";
import { FangornConfig } from "./config.js";
import { PublisherStatus } from "./contracts/index.js";
import { TestBed } from "./test/testbed.js";

// What the protocol admin can do to the network: take an app down, and ban a
// publisher everywhere.
//
// These need an admin, not THE admin. So they run against a local fork of the
// deployed contracts (anvil), where the admin role is handed to a key generated
// here. The real admin key, which can also upgrade the contracts, never has to
// be in a .env or a CI secret, and nothing on the real chain is ever suspended.
// Every wallet is generated and funded on the fork, and commits go straight to
// the registry rather than through storage, so the suite needs no secrets at all.
//
// Not covered, on purpose: fees, the USDC and registry pointers, and upgrades.
// The contracts repo covers them in its Foundry tests and upgrade rehearsals.

const ZERO_BYTES32 =
    "0x0000000000000000000000000000000000000000000000000000000000000000";

// The SDK's ABIs leave setAdmin out on these two registries: it is an operator
// tool. The fork needs it once, to hand the role over.
const ADMIN_ABI = parseAbi([
    "function admin() view returns (address)",
    "function setAdmin(address new_admin)",
]);

const hasAnvil = spawnSync("anvil", ["--version"]).status === 0;

/** Fork the deployed chain locally, on a port anvil picks. */
async function startFork(): Promise<{ anvil: ChildProcess; rpcUrl: string }> {
    const anvil = spawn("anvil", ["--fork-url", FangornConfig.rpcUrl, "--port", "0"], {
        stdio: ["ignore", "pipe", "inherit"],
    });
    const rpcUrl = await new Promise<string>((resolve, reject) => {
        let output = "";
        anvil.stdout.on("data", (chunk: Buffer) => {
            output += chunk.toString();
            const listening = /Listening on (\S+)/.exec(output);
            if (listening) resolve(`http://${listening[1]}`);
        });
        anvil.once("error", reject);
        anvil.once("exit", (code) => {
            reject(new Error(`anvil exited (${String(code)}) before it was listening`));
        });
    });
    return { anvil, rpcUrl };
}

// Without anvil the suite shows as skipped, except in CI, where it has to fail
// rather than quietly stop testing the takedown path.
describe.skipIf(!hasAnvil && !process.env.CI)("Fangorn protocol admin E2E (fork)", () => {
    const OWNER = 0;
    const GUEST = 1;
    const ADMIN = 2;
    let anvil: ChildProcess | undefined;
    let bed: TestBed;

    /**
     * Advance `namespace` for one wallet straight on the DataRegistry. That is
     * the gate these tests are about; going through the engine would only add an
     * upload in front of it.
     */
    async function commit(index: number, namespace: string) {
        const head = await bed.head(index, namespace);
        const next = keccak256(stringToBytes(`${namespace}-${String(Date.now())}`));
        return bed.getFangorn(index).getDataRegistry().commitStateRoot(namespace, head, next);
    }

    beforeAll(async () => {
        if (!hasAnvil) {
            throw new Error("anvil is not installed: in CI the admin tests fail rather than skip");
        }
        const fork = await startFork();
        anvil = fork.anvil;
        const config = { ...FangornConfig, rpcUrl: fork.rpcUrl };
        const chain = createTestClient({
            mode: "anvil",
            chain: config.chain,
            transport: http(config.rpcUrl),
        })
            .extend(publicActions)
            .extend(walletActions);

        bed = TestBed.init(
            [generatePrivateKey(), generatePrivateKey(), generatePrivateKey()],
            undefined,
            config,
        );
        const newAdmin = bed.getFangorn(ADMIN).getAddress();
        for (const index of [OWNER, GUEST, ADMIN]) {
            await chain.setBalance({
                address: bed.getFangorn(index).getAddress(),
                value: parseEther("1"),
            });
        }

        // Hand each registry's admin role to the generated key, as its current
        // admin. Only a fork lets us act as an account we hold no key for.
        const registries: Address[] = [
            config.appRegistryContractAddress,
            config.dataRegistryContractAddress,
        ];
        for (const address of registries) {
            const current = await chain.readContract({
                address,
                abi: ADMIN_ABI,
                functionName: "admin",
            });
            await chain.impersonateAccount({ address: current });
            await chain.setBalance({ address: current, value: parseEther("1") });
            const hash = await chain.writeContract({
                account: current,
                address,
                abi: ADMIN_ABI,
                functionName: "setAdmin",
                args: [newAdmin],
            });
            await chain.waitForTransactionReceipt({ hash });
            await chain.stopImpersonatingAccount({ address: current });
        }
        const admin = bed.getFangorn(ADMIN);
        for (const now of [await admin.getAppRegistry().admin(), await admin.getDataRegistry().admin()]) {
            if (now.toLowerCase() !== newAdmin.toLowerCase()) {
                throw new Error(`the fork's admin is ${now}, not the generated ${newAdmin}`);
            }
        }

        // ponytail: claiming is free while the subscription fee is 0. If it is
        // raised, mint the owner USDC on the fork (anvil_setStorageAt) here.
        // The guest is an ordinary member: registered, invited, joined.
        await bed.registerApp(OWNER);
        await bed.register(GUEST);
        await bed.invite(OWNER, GUEST);
        await bed.getFangorn(GUEST).getAppRegistry().registerForApp();
    }, 180_000);

    afterAll(() => {
        anvil?.kill();
    });

    // The admin takedown, one level above an app owner ejecting a publisher:
    // suspending the app unregisters everyone under it, its owner included.
    it("admin app suspension works", async () => {
        const admin = bed.getFangorn(ADMIN).getAppRegistry();
        const apps = bed.getFangorn(OWNER).getAppRegistry();
        const self = bed.getFangorn(OWNER).getAddress();
        const guest = bed.getFangorn(GUEST).getAddress();
        const namespace = `takedown-${String(Date.now())}`;

        expect(await apps.isAppSuspended()).toBe(false);
        expect(await apps.isRegisteredForApp(self)).toBe(true);
        expect(await apps.isRegisteredForApp(guest)).toBe(true);

        await admin.suspendApp();
        expect(await apps.isAppSuspended()).toBe(true);
        expect(await apps.isRegisteredForApp(self)).toBe(false);
        expect(await apps.isRegisteredForApp(guest)).toBe(false);

        // The membership underneath is untouched — this is a takedown, not an
        // eviction, which is what makes reinstating free for the publishers.
        const info = await apps.joinInfo(self);
        expect(info.appSuspended).toBe(true);
        expect(info.registered).toBe(false);
        expect(info.status).toBe(PublisherStatus.ACTIVE);
        expect(info.acceptedTerms).toBe(info.termsHash);

        // And the DataRegistry reads the same answer: nothing commits.
        await expect(commit(OWNER, namespace)).rejects.toThrow(/NotRegisteredForApp/);
        await expect(commit(GUEST, namespace)).rejects.toThrow(/NotRegisteredForApp/);

        await admin.reinstateApp();
        expect(await apps.isAppSuspended()).toBe(false);
        expect(await apps.isRegisteredForApp(self)).toBe(true);
        expect(await apps.isRegisteredForApp(guest)).toBe(true);

        // Reinstated means publishing again, not just reading as registered.
        await commit(OWNER, namespace);
        expect(await bed.head(OWNER, namespace)).not.toBe(ZERO_BYTES32);
    }, 120_000);

    // The network-wide ban. It is on the wallet, not on one app: a suspended
    // publisher cannot commit anywhere, cannot register its way back in, and
    // cannot start over by claiming an app of its own.
    it("admin publisher suspension works", async () => {
        const admin = bed.getFangorn(ADMIN).getDataRegistry();
        const guest = bed.getFangorn(GUEST);
        const data = guest.getDataRegistry();
        const apps = guest.getAppRegistry();
        const self = guest.getAddress();
        const stamp = String(Date.now());
        const namespace = `ban-${stamp}`;

        // In good standing, it publishes.
        await commit(GUEST, namespace);
        const head = await bed.head(GUEST, namespace);
        expect(head).not.toBe(ZERO_BYTES32);

        await admin.suspendPublisher(self);
        expect(await data.getPublisherStatus(self)).toBe(PublisherStatus.SUSPENDED);
        expect(await data.isRegistered(self)).toBe(false);

        await expect(commit(GUEST, namespace)).rejects.toThrow(/PublisherSuspendedErr/);
        await expect(data.register()).rejects.toThrow(/PublisherSuspendedErr/);

        const suiteApp = guest.getAppId();
        guest.setAppId(`banned-app-${stamp}`);
        try {
            await expect(
                apps.registerApp(keccak256(stringToBytes("terms")), "https://example.test/terms", 0n),
            ).rejects.toThrow(/NotRegisteredGlobally/);
        } finally {
            guest.setAppId(suiteApp);
        }

        // The ban is one wallet's: the app's owner still publishes.
        await commit(OWNER, namespace);

        // Lifting it restores the wallet where it stood: same head, and the next
        // commit builds on it.
        await admin.reinstateGlobal(self);
        expect(await data.getPublisherStatus(self)).toBe(PublisherStatus.ACTIVE);
        expect(await bed.head(GUEST, namespace)).toBe(head);

        await commit(GUEST, namespace);
        expect(await bed.head(GUEST, namespace)).not.toBe(head);
    }, 120_000);
});
