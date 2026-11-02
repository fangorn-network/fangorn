import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Hex } from "viem";
import { appId } from "../config.js";
import { FANGORN_APP_EXTENSION } from "../fangorn.js";
import { chainNetwork, type ChainNetwork, skipChain } from "../test/testbed.js";

// App names on the contracts, and an app found from nothing but its agent card.

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

describe.skipIf(skipChain)("Apps (contracts on anvil)", () => {
	let net: ChainNetwork;
	beforeAll(async () => {
		net = await chainNetwork();
	}, 120_000);
	afterAll(() => {
		net.stop();
	});

	/** A client managing `name`, registered by it. */
	const registered = async (name: string) => {
		const f = await net.raw(name);
		await f.getAppRegistry().registerApp();
		return f;
	};

	it("registering is free, and the owner points the app at its repo and payout", async () => {
		const owner = await registered("claimed");
		const apps = owner.getAppRegistry();
		expect(await apps.getAppOwner()).toBe(owner.getAddress());
		expect(await apps.curatorOf()).toEqual({ curator: owner.getAddress(), repo: "" });
		expect(await apps.payoutOf()).toBe(owner.getAddress());

		const other = await net.raw();
		await apps.setCurator(other.getAddress(), "picks");
		await apps.setPayout(other.getAddress());
		expect(await apps.curatorOf()).toEqual({ curator: other.getAddress(), repo: "picks" });
		expect(await apps.payoutOf()).toBe(other.getAddress());

		const squatter = await net.raw("claimed");
		await expect(squatter.getAppRegistry().registerApp()).rejects.toThrow(/AppAlreadyRegistered/);
		await expect(squatter.getAppRegistry().setPayout(squatter.getAddress())).rejects.toThrow(/Unauthorized/);
	}, 60_000);

	it("an unregistered app has no owner, and can't be changed", async () => {
		const f = await net.raw(`unclaimed-${String(Date.now())}`);
		const apps = f.getAppRegistry();
		expect(await apps.getAppOwner()).toBe(ZERO_ADDRESS);
		await expect(apps.setCurator(f.getAddress(), "x")).rejects.toThrow(/AppNotFound/);
	}, 60_000);

	it("a renamed app answers to every name it went by", async () => {
		const owner = await registered("before-rename");
		const apps = owner.getAppRegistry();
		// A client still on the old name, who never hears of the rename.
		const stale = await net.raw("before-rename");
		const fromBlock = await net.clock();

		await owner.renameApp("after-rename");
		expect(owner.getAppId()).toBe(appId("after-rename"));
		expect(await apps.canonicalAppId()).toBe(appId("before-rename"));
		expect(await apps.currentAppId(appId("before-rename"))).toBe(appId("after-rename"));
		expect(await stale.getAppRegistry().currentAppId()).toBe(appId("after-rename"));
		expect(await stale.getAppRegistry().getAppOwner()).toBe(owner.getAddress());

		// Events carry the canonical id, and are found by any name.
		await apps.setAppAgentUri("https://renamed.example/card.json");
		const logs = await apps.getAppAgentLogs({ appId: appId("after-rename"), fromBlock });
		expect(logs.map((l) => [l.appId, l.agentUri])).toEqual([[appId("before-rename"), "https://renamed.example/card.json"]]);

		// The old name stays the app's: nobody can claim it.
		const squatter = await net.raw("before-rename");
		await expect(squatter.getAppRegistry().registerApp()).rejects.toThrow(/AppAlreadyRegistered/);
	}, 60_000);

	it("an app can rename back, but not onto another app's name, and only its owner renames it", async () => {
		const owner = await registered("rename-back");
		await registered("someone-elses");
		const stranger = await net.raw("rename-back");

		await expect(owner.renameApp("someone-elses")).rejects.toThrow(/AppAlreadyRegistered/);
		expect(owner.getAppId()).toBe(appId("rename-back"));
		await expect(stranger.renameApp("stranger-took-it")).rejects.toThrow(/Unauthorized/);

		await owner.renameApp("renamed-once");
		await owner.renameApp("rename-back");
		expect(await owner.getAppRegistry().currentAppId(appId("renamed-once"))).toBe(appId("rename-back"));
		expect(await owner.getAppRegistry().canonicalAppId(appId("renamed-once"))).toBe(appId("rename-back"));
	}, 60_000);
});

// App registration as an agent: an app registers its id, points `agent_uri` at
// its A2A card, its owner publishes, and a client holding only the card URL finds
// it all. Trust comes from the on-chain binding (`appAgentUri(appId) === cardUrl`),
// checked by `discoverApp`, not from the transport.
describe.skipIf(skipChain)("App as agent (contracts on anvil)", () => {
	const REPO = "catalog";
	const cards: Record<string, unknown> = {};
	let server: Server;
	let origin: string;
	let net: ChainNetwork;

	function card(params: { appId: Hex; fromBlock: string; repos: string[] }) {
		return {
			protocolVersion: "0.3.0",
			name: "E2E Fangorn App",
			url: origin,
			capabilities: {
				extensions: [
					{
						uri: FANGORN_APP_EXTENSION,
						params: {
							chainId: net.config.caip2,
							appRegistry: net.config.appRegistryContractAddress,
							dataRegistry: net.config.dataRegistryContractAddress,
							...params,
						},
					},
				],
			},
			skills: [],
		};
	}

	beforeAll(async () => {
		server = createServer((req, res) => {
			const body = cards[req.url ?? ""];
			if (!body) return res.writeHead(404).end();
			res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
		net = await chainNetwork();
	}, 120_000);

	afterAll(() => {
		server.close();
		net.stop();
	});

	it("binds a card, and a reader finds the app's data from the card alone", async () => {
		const name = "agent-app";
		const fromBlock = await net.clock();
		const owner = await net.raw(name);
		const apps = owner.getAppRegistry();
		await apps.registerApp();

		const cardUrl = `${origin}/.well-known/agent-card.json`;
		cards["/.well-known/agent-card.json"] = card({ appId: appId(name), fromBlock: fromBlock.toString(), repos: [REPO] });
		const bindTx = await apps.setAppAgentUri(cardUrl);
		expect(await apps.appAgentUri()).toBe(cardUrl);

		// The binding is announced, per app and in the every-app listing.
		const mine = await apps.getAppAgentLogs({ appId: appId(name), fromBlock });
		expect(mine.map((l) => [l.appId, l.agentUri, l.transactionHash])).toEqual([[appId(name), cardUrl, bindTx]]);
		expect(await apps.getAppAgentLogs({ fromBlock })).toContainEqual(mine[0]);

		await owner.initRepo(REPO);
		await owner.upload(REPO, { title: "hello from the app" }, "entry");

		// A stranger holding only the URL.
		const reader = await net.raw();
		const found = await reader.discoverApp(cardUrl);
		expect(found).toMatchObject({ appId: appId(name), fromBlock, repos: [REPO] });

		const listed = await reader.repos({ repo: REPO, fromBlock: found.fromBlock });
		expect(listed.map((t) => t.owner)).toEqual([owner.getAddress()]);
		const { contents } = await reader.readRepo(listed[0].owner, REPO);
		expect(contents.records.map((v) => v.payload.title)).toEqual(["hello from the app"]);
	}, 60_000);

	// Anyone can serve a card claiming any appId; only the owner sets `agent_uri`.
	it("rejects a card that claims an app not bound to it", async () => {
		cards["/forged.json"] = card({ appId: appId("agent-app"), fromBlock: "0", repos: [REPO] });
		const reader = await net.raw();
		await expect(reader.discoverApp(`${origin}/forged.json`)).rejects.toThrow(/not bound|agent_uri/i);
	}, 60_000);
});
