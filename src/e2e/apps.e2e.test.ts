import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Hex } from "viem";
import { PublisherStatus } from "../contracts/index.js";
import { appId } from "../config.js";
import { FANGORN_APP_EXTENSION } from "../fangorn.js";
import { appOf } from "../test/sdk-suite.js";
import { chainNetwork, type ChainNetwork, skipChain } from "../test/testbed.js";

// App management on the contracts: claiming (the storage subscription),
// accepting publishers, and an app found from nothing but its agent card.

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

describe.skipIf(skipChain)("Apps (contracts on anvil)", () => {
	let net: ChainNetwork;
	beforeAll(async () => {
		net = await chainNetwork();
	}, 120_000);
	afterAll(() => {
		net.stop();
	});

	it("claiming an app pays its subscription and makes the claimer its first publisher", async () => {
		const owner = await net.client("claimed");
		const apps = owner.getAppRegistry();
		const access = await apps.access(owner.getAddress());
		expect(access).toMatchObject({ canPublish: true, owner: owner.getAddress() });
		expect(access.expiresAt).toBe(await apps.expiresAt());
		const now = (await net.chain.getBlock()).timestamp;
		expect(access.expiresAt - now).toBeGreaterThan(29n * 24n * 3600n);
		expect(await apps.status(owner.getAddress())).toBe(PublisherStatus.ACTIVE);
	}, 60_000);

	// The owner's acceptance is the whole membership, and it is what gets a publisher
	// storage and presented.
	it("an accepted publisher is presented; one not accepted is not", async () => {
		const owner = await net.client("accepts");
		const guest = await net.raw("accepts");
		const apps = guest.getAppRegistry();
		const self = guest.getAddress();

		// Not accepted: the app presents nothing, and no wallet but the owner's can accept.
		expect(await apps.status(self)).toBe(PublisherStatus.NONE);
		await guest.initRepo("early");
		expect(await guest.getRegistry().presents(appOf(guest), self)).toBe(false);
		await expect(apps.acceptPublisher(self)).rejects.toThrow(/Unauthorized/);

		await owner.getAppRegistry().acceptPublisher(self);
		expect(await apps.status(self)).toBe(PublisherStatus.ACTIVE);
		expect(await apps.canPublish(self)).toBe(true);
		await expect(owner.getAppRegistry().acceptPublisher(self)).rejects.toThrow(/AlreadyAccepted/);

		await guest.initRepo("catalog");
		const { payloadCid } = await guest.upload("catalog", { event: "from the guest" }, "e", "g");
		const { contents } = await owner.readRepo(self, "catalog");
		expect(contents.records.map((v) => v.cid)).toEqual([payloadCid]);
	}, 60_000);

	it("an unclaimed app has no owner and accepts nobody", async () => {
		const f = await net.raw(`unclaimed-${String(Date.now())}`);
		const apps = f.getAppRegistry();
		expect(await apps.getAppOwner()).toBe(ZERO_ADDRESS);
		expect(await apps.canPublish(f.getAddress())).toBe(false);
		await expect(apps.acceptPublisher(f.getAddress())).rejects.toThrow(/AppNotFound/);
	}, 60_000);

	// A rename moves nothing: the new name is an alias, and the app's members,
	// subscription and token answer to every name it went by.
	it("a renamed app answers to every name it went by", async () => {
		const owner = await net.client("before-rename");
		const apps = owner.getAppRegistry();
		// A member still on the old name, who never hears of the rename.
		const guest = await net.client("before-rename");
		const expiry = await apps.expiresAt();
		const fromBlock = await net.clock();

		await owner.renameApp("after-rename");
		expect(owner.getAppId()).toBe(appId("after-rename"));
		expect(await apps.canonicalAppId()).toBe(appId("before-rename"));
		expect(await apps.currentAppId(appId("before-rename"))).toBe(appId("after-rename"));
		expect(await guest.getAppRegistry().currentAppId()).toBe(appId("after-rename"));

		// Under the new name: the owner, the member, and the subscription, whose
		// token is still the old id.
		expect(await apps.getAppOwner()).toBe(owner.getAddress());
		expect(await apps.status(guest.getAddress())).toBe(PublisherStatus.ACTIVE);
		expect(await apps.canPublish(guest.getAddress())).toBe(true);
		expect(await apps.tokenId()).toBe(BigInt(appId("before-rename")));
		expect(await apps.expiresAt()).toBe(expiry);
		expect(await apps.isRenewable()).toBe(false);

		// The member publishes under the old name; the owner reads it under the new one.
		await guest.initRepo("renamed");
		const { payloadCid } = await guest.upload("renamed", { event: "under the old name" }, "e", "r");
		const { contents } = await owner.readRepo(guest.getAddress(), "renamed");
		expect(contents.records.map((v) => v.cid)).toEqual([payloadCid]);
		const listed = await owner.appRepos({ repo: "renamed", fromBlock });
		expect(listed.map((t) => t.owner)).toEqual([guest.getAddress()]);

		// Events carry the canonical id, and are found by any name.
		await apps.setAppAgentUri("https://renamed.example/card.json");
		const logs = await apps.getAppAgentLogs({ appId: appId("after-rename"), fromBlock });
		expect(logs.map((l) => [l.appId, l.agentUri])).toEqual([[appId("before-rename"), "https://renamed.example/card.json"]]);

		// The old name stays the app's: nobody can claim it.
		const squatter = await net.raw("before-rename");
		await expect(squatter.getAppRegistry().registerApp()).rejects.toThrow(/AppAlreadyRegistered/);

		// Ending the subscription under the new name ends the app's one.
		await apps.cancelSubscription();
		expect(await guest.getAppRegistry().expiresAt()).toBe(0n);
	}, 60_000);

	it("an app can rename back, but not onto another app's name, and only its owner renames it", async () => {
		const owner = await net.client("rename-back");
		await net.client("someone-elses");
		const guest = await net.client("rename-back");

		await expect(owner.renameApp("someone-elses")).rejects.toThrow(/AppAlreadyRegistered/);
		expect(owner.getAppId()).toBe(appId("rename-back"));
		await expect(guest.renameApp("guest-took-it")).rejects.toThrow(/Unauthorized/);

		await owner.renameApp("renamed-once");
		await owner.renameApp("rename-back");
		expect(await owner.getAppRegistry().currentAppId(appId("renamed-once"))).toBe(appId("rename-back"));
		expect(await owner.getAppRegistry().canonicalAppId(appId("renamed-once"))).toBe(appId("rename-back"));
	}, 60_000);

	// The other half of admin.e2e.test.ts: nobody but the admin takes anything down.
	it("only the protocol admin can suspend an app or ban a wallet", async () => {
		const owner = await net.client("not-admin");
		const apps = owner.getAppRegistry();
		await expect(apps.setAppSuspended(true)).rejects.toThrow(/Unauthorized/);
		await expect(apps.setGlobalSuspension(owner.getAddress(), true)).rejects.toThrow(/Unauthorized/);
		expect(await apps.isAppSuspended()).toBe(false);
		expect(await apps.isGloballySuspended(owner.getAddress())).toBe(false);
	}, 60_000);
});

// App registration as an agent: an app claims its id, points `agent_uri` at its
// A2A card, a member publishes, and a client holding only the card URL finds it
// all. Trust comes from the on-chain binding (`appAgentUri(appId) === cardUrl`),
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
		const owner = await net.client(name);
		const apps = owner.getAppRegistry();

		const cardUrl = `${origin}/.well-known/agent-card.json`;
		cards["/.well-known/agent-card.json"] = card({ appId: appId(name), fromBlock: fromBlock.toString(), repos: [REPO] });
		const bindTx = await apps.setAppAgentUri(cardUrl);
		expect(await apps.appAgentUri()).toBe(cardUrl);

		// The binding is announced, per app and in the every-app listing.
		const mine = await apps.getAppAgentLogs({ appId: appId(name), fromBlock });
		expect(mine.map((l) => [l.appId, l.agentUri, l.transactionHash])).toEqual([[appId(name), cardUrl, bindTx]]);
		expect(await apps.getAppAgentLogs({ fromBlock })).toContainEqual(mine[0]);
		// The card is not the terms: binding it drops nobody.
		expect(await apps.canPublish(owner.getAddress())).toBe(true);

		await owner.initRepo(REPO);
		await owner.upload(REPO, { title: "hello from the app" }, "entry");

		// A stranger under no app, holding only the URL.
		const reader = await net.raw();
		const found = await reader.discoverApp(cardUrl);
		expect(found).toMatchObject({ appId: appId(name), fromBlock, repos: [REPO] });

		reader.setAppId(found.appId);
		const listed = await reader.appRepos({ repo: REPO, fromBlock: found.fromBlock });
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
