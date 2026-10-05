import { describe, it, expect, vi, afterEach } from "vitest";
import { Fangorn, FANGORN_APP_EXTENSION } from "./fangorn.js";
import { FangornConfig, appId } from "./config.js";

const CARD_URL = "https://app.example/.well-known/agent-card.json";
const APP = appId("discover-test");

function client() {
    // Throwaway key: discoverApp never signs, and the chain read is stubbed below.
    return Fangorn.create({ privateKey: `0x${"11".repeat(32)}`, config: FangornConfig });
}

function cardWith(params: Record<string, unknown>) {
    return {
        name: "Test",
        capabilities: {
            extensions: [
                {
                    uri: FANGORN_APP_EXTENSION,
                    params: {
                        chainId: FangornConfig.caip2,
                        appRegistry: FangornConfig.appRegistryContractAddress,
                        appId: APP,
                        fromBlock: "123",
                        namespaces: ["catalog"],
                        ...params,
                    },
                },
            ],
        },
    };
}

/** Serve `body` from fetch and answer `appAgentUri` with `bound`. */
function setup(body: unknown, bound: string = CARD_URL, status = 200) {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
    vi.stubGlobal("fetch", fetchMock);
    const f = client();
    const agentUri = vi.spyOn(f.getAppRegistry(), "appAgentUri").mockResolvedValue(bound);
    return { f, fetchMock, agentUri };
}

describe("discoverApp", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("resolves a card bound on-chain to its app", async () => {
        const card = cardWith({});
        const { f, agentUri } = setup(card);
        const appBefore = f.getAppId();

        const found = await f.discoverApp(CARD_URL);

        expect(found).toEqual({ card, appId: APP, fromBlock: 123n, namespaces: ["catalog"] });
        // The binding is read for the card's app, not the client's own...
        expect(agentUri).toHaveBeenCalledWith(APP);
        // ...and the client's app is left alone.
        expect(f.getAppId()).toBe(appBefore);
    });

    it("defaults namespaces to empty", async () => {
        const { f } = setup(cardWith({ namespaces: undefined }));
        expect((await f.discoverApp(CARD_URL)).namespaces).toEqual([]);
    });

    it("accepts a registry address in any case", async () => {
        const { f } = setup(cardWith({ appRegistry: FangornConfig.appRegistryContractAddress.toUpperCase().replace("0X", "0x") }));
        await expect(f.discoverApp(CARD_URL)).resolves.toMatchObject({ appId: APP });
    });

    it("rejects a card that cannot be fetched", async () => {
        const { f } = setup({}, CARD_URL, 404);
        await expect(f.discoverApp(CARD_URL)).rejects.toThrow(/HTTP 404/);
    });

    it("rejects a card with no Fangorn extension", async () => {
        const { f, agentUri } = setup({ name: "plain A2A agent", capabilities: { extensions: [{ uri: "https://other/ext" }] } });
        await expect(f.discoverApp(CARD_URL)).rejects.toThrow(/no .* extension/);
        expect(agentUri).not.toHaveBeenCalled();
    });

    it.each([
        ["appId missing", { appId: undefined }, /appId/],
        ["appId short", { appId: "0x1234" }, /appId/],
        ["appId not hex", { appId: `0x${"zz".repeat(32)}` }, /appId/],
        ["fromBlock missing", { fromBlock: undefined }, /fromBlock/],
        ["fromBlock a number", { fromBlock: 123 }, /fromBlock/],
        ["fromBlock negative", { fromBlock: "-1" }, /fromBlock/],
        ["fromBlock hex", { fromBlock: "0x10" }, /fromBlock/],
        ["namespaces not a list", { namespaces: "catalog" }, /namespaces/],
        ["namespaces not strings", { namespaces: ["ok", 7] }, /namespaces/],
    ])("rejects a malformed extension: %s", async (_, params, error) => {
        const { f, agentUri } = setup(cardWith(params));
        await expect(f.discoverApp(CARD_URL)).rejects.toThrow(error);
        expect(agentUri).not.toHaveBeenCalled();
    });

    it.each([
        ["another chain", { chainId: 1 }],
        ["chainId as a string", { chainId: String(FangornConfig.caip2) }],
        ["another AppRegistry", { appRegistry: `0x${"ab".repeat(20)}` }],
        ["no AppRegistry", { appRegistry: undefined }],
    ])("rejects a card for a different deployment: %s", async (_, params) => {
        const { f, agentUri } = setup(cardWith(params));
        await expect(f.discoverApp(CARD_URL)).rejects.toThrow(/not this client's/);
        expect(agentUri).not.toHaveBeenCalled();
    });

    it.each([
        ["app has no card", ""],
        ["app bound to another card", "https://elsewhere.example/.well-known/agent-card.json"],
        // Exact match on purpose: no URL normalization to widen what counts as the card.
        ["trailing slash differs", `${CARD_URL}/`],
    ])("rejects a card its app does not point back at: %s", async (_, bound) => {
        const { f } = setup(cardWith({}), bound);
        await expect(f.discoverApp(CARD_URL)).rejects.toThrow(/not bound to app/);
    });
});
