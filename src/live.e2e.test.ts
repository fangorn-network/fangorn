import { describe, it, expect } from "vitest";
import { createPublicClient, http, parseAbiItem } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { DEFAULT_APP, FangornConfig } from "./config.js";
import { APP_REGISTRY_ABI, PublisherStatus } from "./contracts/index.js";
import { TestBed } from "./test/testbed.js";

// The only tests that touch the real chain, and they only read it.
//
// Everything that writes runs on a local fork (e2e.test.ts,
// app-agent.e2e.test.ts, admin.e2e.test.ts): nothing in the registries can be
// deleted, so a suite that claimed apps and registered wallets there on every
// run would fill them with test data for good. What a fork cannot show is
// checked here, reading only: that the deployed contracts are wired to each
// other, and that the public RPC still serves the log scans the SDK relies on.

const client = createPublicClient({ transport: http(FangornConfig.rpcUrl) });

describe("Fangorn live deployment (read-only)", () => {
    // Reading needs no funds, so the wallet is one nobody else has.
    const reader = TestBed.init([generatePrivateKey()], DEFAULT_APP).getFangorn(0);

    // The contracts are deployed independently and point at each other by
    // address. A redeploy that updates one address and not the other is silent
    // until a commit reverts NotRegisteredForApp for a publisher who plainly
    // joined, or a claim reverts NotRegisteredGlobally for one who plainly
    // registered. Asserting the pointers here is the cheapest place to catch a
    // half-finished deploy.
    it("registries are properly wired", async () => {
        const data = reader.getDataRegistry();
        const apps = reader.getAppRegistry();
        const settlement = reader.getSettlementRegistry();

        expect((await data.appRegistry()).toLowerCase()).toBe(
            apps.getAddress().toLowerCase(),
        );
        // ...and back: the AppRegistry asks this DataRegistry who is a registered
        // publisher. Unwired, it treats everyone as unregistered and no app can
        // be claimed.
        expect((await apps.dataRegistry()).toLowerCase()).toBe(
            data.getAddress().toLowerCase(),
        );
        // Both paywalls settle in the same token, or a price quoted by one means
        // nothing to the other.
        expect((await apps.usdc()).toLowerCase()).toBe(
            (await settlement.getUsdc()).toLowerCase(),
        );

        // setAppId moves the app-scoped clients together and leaves the
        // per-wallet one alone (CO-1).
        const before = reader.getAppId();
        reader.setAppId("some-other-app");
        expect(apps.getAppId()).toBe(reader.getAppId());
        expect(data.getAppId()).toBe(reader.getAppId());
        reader.setAppId(before);
    }, 60_000);

    // Log scans start at `appRegistryFromBlock`. Too late a block and they miss
    // what came before it, without any error.
    it("the config's start block is the AppRegistry's deployment", async () => {
        const deployed = await client.getLogs({
            address: FangornConfig.appRegistryContractAddress,
            event: parseAbiItem("event Initialized(uint64 version)"),
            fromBlock: FangornConfig.appRegistryFromBlock,
            toBlock: FangornConfig.appRegistryFromBlock,
        });
        expect(deployed).toHaveLength(1);
    }, 60_000);

    // The invitation scan asks the RPC for the registry's whole history in wide
    // windows. An endpoint that stops serving them fails here, not for a user.
    it("the public RPC serves the invitation scan", async () => {
        // An invitation from the registry's first days, so there is one to find.
        const [first] = await client.getContractEvents({
            address: FangornConfig.appRegistryContractAddress,
            abi: APP_REGISTRY_ABI,
            eventName: "PublisherInvited",
            fromBlock: FangornConfig.appRegistryFromBlock,
            toBlock: FangornConfig.appRegistryFromBlock + 1_000_000n,
            strict: true,
        });
        const { app_id: appId, publisher } = first.args;

        // It is listed exactly when the contract says it still stands.
        const before = reader.getAppId();
        reader.setAppId(appId);
        const { status } = await reader.getAppRegistry().joinInfo(publisher);
        reader.setAppId(before);
        const listed = (await reader.getInvitations(publisher)).some((i) => i.appId === appId);
        expect(listed).toBe(status === PublisherStatus.INVITED);

        expect(await reader.getInvitations()).toEqual([]);
    }, 60_000);
});
