import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Hex } from "viem";
import { cleanUp, type Fork, skipFork, startFork } from "./test/testbed.js";
import { DEFAULT_APP, FangornConfig, appId } from "./config.js";
import { FANGORN_APP_EXTENSION } from "./fangorn.js";

// App registration as an agent, end to end: an app claims its id, points
// `agent_uri` at its A2A agent card, a publisher publishes into it, and a
// client holding nothing but the card URL finds all of it.
//
// The card is served here over plain HTTP, the way the access worker serves
// `/.well-known/agent-card.json` — it is a live document derived from the
// gateway's origin, not a pinned one. Trust comes from the on-chain binding
// (`appAgentUri(appId) === cardUrl`), checked by `discoverApp`, not from the
// transport or from content addressing.
//
// It runs on a local fork of the deployed chain: on the real one, every run
// would leave another app in the registry, bound to a card on a localhost port
// that every later scan of the directory then tries to read.

const NAMESPACE = "catalog";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Serve `cards[path]` as JSON on an ephemeral localhost port. */
async function serveCards(cards: Record<string, unknown>): Promise<{ server: Server; origin: string }> {
    const server = createServer((req, res) => {
        const card = cards[req.url ?? ""];
        if (!card) return res.writeHead(404).end();
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(card));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return { server, origin: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}` };
}

function card(origin: string, params: { appId: Hex; fromBlock: string; namespaces: string[] }) {
    return {
        protocolVersion: "0.3.0",
        name: "E2E Fangorn App",
        description: "An app registered as an agent by the e2e suite.",
        version: "0.0.1",
        url: origin,
        capabilities: {
            streaming: false,
            pushNotifications: false,
            stateTransitionHistory: false,
            extensions: [
                {
                    uri: FANGORN_APP_EXTENSION,
                    description: "The Fangorn app this agent fronts.",
                    required: false,
                    params: {
                        chainId: FangornConfig.caip2,
                        appRegistry: FangornConfig.appRegistryContractAddress,
                        dataRegistry: FangornConfig.dataRegistryContractAddress,
                        ...params,
                    },
                },
            ],
        },
        defaultInputModes: ["application/json"],
        defaultOutputModes: ["application/json"],
        skills: [],
    };
}

describe.skipIf(skipFork)("App as agent E2E (fork)", () => {
    const appName = `agent-app-${String(Date.now())}`;
    const cards: Record<string, unknown> = {};
    let server: Server;
    let origin: string;
    let fork: Fork;
    // The app's owner: generated on the fork, and given gas there.
    let OWNER_KEY: Hex;

    beforeAll(async () => {
        if (!process.env.PINATA_JWT) throw new Error("PINATA_JWT is not set: the suite uploads to Pinata");
        // origin = 127.0.0.1
        ({ server, origin } = await serveCards(cards));
        fork = await startFork();
        OWNER_KEY = await fork.wallet();
    }, 60_000);

    afterAll(async () => {
        server.close();
        await cleanUp();
    }, 300_000);

    it("registers an app, binds its agent card, and discovers publishers' data from the card", async () => {
        // app owner = single publisher
        const bed = fork.bed([OWNER_KEY], appName);
        const owner = bed.getFangorn(0);
        const apps = owner.getAppRegistry();

        //  the agent was NOT registered before this block
        const fromBlock = await fork.chain.getBlockNumber();

        // 1. Claim the app.
        await bed.registerApp(0);
        expect((await apps.getAppOwner()).toLowerCase()).toBe(owner.getAddress().toLowerCase());
        expect(await apps.appAgentUri()).toBe("");

        // 2. Publish the card and bind it on-chain.
        const cardPath = "/.well-known/agent-card.json";
        const cardUrl = `${origin}${cardPath}`;
        cards[cardPath] = card(origin, {
            appId: appId(appName),
            fromBlock: fromBlock.toString(),
            namespaces: [NAMESPACE],
        });
        const bindTx = await apps.setAppAgentUri(cardUrl);
        expect(await apps.appAgentUri()).toBe(cardUrl);

        // The binding is announced: this is what an agent enumerating apps reads.
        const mine = await apps.getAppAgentLogs({ appId: appId(appName), fromBlock });
        expect(mine.map((l) => [l.appId, l.agentUri, l.transactionHash])).toEqual([
            [appId(appName), cardUrl, bindTx],
        ]);
        // ...and it shows up in the unfiltered, every-app listing too.
        expect(await apps.getAppAgentLogs({ fromBlock })).toContainEqual(mine[0]);
        // The card is not the terms: binding it must not unregister anyone.
        expect(await apps.isRegisteredForApp(owner.getAddress())).toBe(true);

        // 3. Publish into the app's declared namespace.
        await bed.register(0);
        await bed.initRepo(0, NAMESPACE);
        const publisher = owner.getAddress().toLowerCase();
        await bed.upload(0, NAMESPACE, { title: "hello from the app" }, "entry");

        // 4. A stranger holding only the card URL — on the default app, with no
        //    idea this app exists — resolves it and reads everything.
        const reader = fork.bed([OWNER_KEY], DEFAULT_APP).getFangorn(0);
        const found = await reader.discoverApp(cardUrl);
        expect(found.appId).toBe(appId(appName));
        expect(found.fromBlock).toBe(fromBlock);
        expect(found.namespaces).toEqual([NAMESPACE]);

        reader.setAppId(found.appId);
        await sleep(5000); // pinata
        const timelines = await reader.appNamespaces({ namespace: NAMESPACE, fromBlock: found.fromBlock });
        expect(timelines.map((t) => t.owner.toLowerCase())).toEqual([publisher]);

        const { contents } = await reader.readNamespace(timelines[0].owner, NAMESPACE);
        expect(contents.vertices.map((v) => v.payload.title)).toEqual(["hello from the app"]);
    }, 600_000);

    // Anyone can serve a card claiming any appId. Only the app owner can set
    // `agent_uri`, so the binding is checked in the card → chain direction.
    it("rejects a card that claims an app not bound to it", async () => {
        const forgedPath = "/forged/agent-card.json";
        cards[forgedPath] = card(origin, { appId: appId("fangorn"), fromBlock: "0", namespaces: [NAMESPACE] });

        const reader = fork.bed([OWNER_KEY]).getFangorn(0);
        await expect(reader.discoverApp(`${origin}${forgedPath}`)).rejects.toThrow(/not bound|agent_uri/i);
    }, 60_000);
});
