import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Hex } from "viem";
import { DATA_REGISTRY_ABI, needsReacceptance, PublisherStatus } from "../contracts/index.js";
import { appId } from "../config.js";
import { FANGORN_APP_EXTENSION } from "../fangorn.js";
import { ZERO_HEAD } from "../registry.js";
import { appOf } from "../test/sdk-suite.js";
import { chainNetwork, type ChainNetwork, skipChain, TEST_TERMS } from "../test/testbed.js";

// App management on the contracts: claiming (the storage subscription),
// invitations, terms, and an app found from nothing but its agent card.

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

describe.skipIf(skipChain)("Apps (contracts on anvil)", () => {
	let net: ChainNetwork;
	beforeAll(async () => {
		net = await chainNetwork();
	}, 120_000);
	afterAll(() => {
		net.stop();
	});

	// Deployed independently, the two point at each other by address. A
	// half-finished redeploy is silent until every acceptance is refused.
	it("the registries are wired to each other", async () => {
		const apps = (await net.raw()).getAppRegistry();
		expect(await apps.dataRegistry()).toBe(net.config.dataRegistryContractAddress);
		const back = await net.chain.readContract({
			address: net.config.dataRegistryContractAddress,
			abi: DATA_REGISTRY_ABI,
			functionName: "appRegistry",
		});
		expect(back).toBe(net.config.appRegistryContractAddress);
	}, 60_000);

	it("claiming an app pays its subscription and makes the claimer its first member", async () => {
		const owner = await net.client("claimed");
		const apps = owner.getAppRegistry();
		const access = await apps.access(owner.getAddress());
		expect(access).toMatchObject({ canPublish: true, owner: owner.getAddress() });
		expect(access.expiresAt).toBe(await apps.expiresAt());
		const now = (await net.chain.getBlock()).timestamp;
		expect(access.expiresAt - now).toBeGreaterThan(29n * 24n * 3600n);

		const info = await apps.joinInfo(owner.getAddress());
		expect(info.termsHash).toBe(TEST_TERMS);
		expect(info.acceptedTerms).toBe(info.termsHash);
		expect(needsReacceptance(info)).toBe(false);
	}, 60_000);

	// Membership is by invitation, and it is what gets a publisher's heads accepted.
	it("an invited publisher joins and is presented; an uninvited one is not", async () => {
		const owner = await net.client("invites");
		const guest = await net.raw("invites");
		const apps = guest.getAppRegistry();
		const self = guest.getAddress();

		// Uninvited: the client refuses the join, and the app presents nothing.
		expect((await apps.joinInfo(self)).status).toBe(PublisherStatus.NONE);
		await expect(apps.joinApp()).rejects.toThrow(/has not been invited/i);
		await guest.initRepo("early");
		expect(await guest.getRegistry().accepted(appOf(guest), { publisher: self, repo: "early" })).toBe(ZERO_HEAD);

		// Invited is not yet a member, and the guest finds the invitation unprompted.
		await owner.getAppRegistry().invitePublisher(self);
		expect((await apps.joinInfo(self)).status).toBe(PublisherStatus.INVITED);
		expect(await apps.canPublish(self)).toBe(false);
		expect(await guest.getInvitations()).toMatchObject([{ appId: guest.getAppId(), owner: owner.getAddress() }]);

		await apps.joinApp();
		expect(await guest.getInvitations()).toEqual([]);
		expect((await apps.joinInfo(self)).status).toBe(PublisherStatus.ACTIVE);

		await guest.initRepo("catalog");
		const { payloadCid } = await guest.upload("catalog", { event: "from the guest" }, "e", "g");
		const { contents } = await owner.readRepo(self, "catalog");
		expect(contents.records.map((v) => v.cid)).toEqual([payloadCid]);
	}, 60_000);

	it("new terms stop a member's acceptances until it re-accepts them", async () => {
		const owner = await net.client("terms");
		const member = await net.client("terms");
		await member.initRepo("r");
		await owner.getAppRegistry().setAppTerms(`0x${"03".repeat(32)}`, "https://example.test/terms-v2");

		const info = await member.getAppRegistry().joinInfo(member.getAddress());
		expect(needsReacceptance(info)).toBe(true);
		await member.upload("r", { n: 1 }, "t", "x");
		expect((await owner.readRepo(member.getAddress(), "r")).contents.records).toEqual([]);

		await member.getAppRegistry().acceptUpdatedTerms();
		await member.upload("r", { n: 2 }, "t", "y");
		expect((await owner.readRepo(member.getAddress(), "r")).contents.records).toHaveLength(2);
	}, 60_000);

	it("an unclaimed app has no owner and cannot be joined", async () => {
		const f = await net.raw(`unclaimed-${String(Date.now())}`);
		const apps = f.getAppRegistry();
		expect(await apps.getAppOwner()).toBe(ZERO_ADDRESS);
		expect(await apps.canPublish(f.getAddress())).toBe(false);
		await expect(apps.joinApp()).rejects.toThrow(/no terms/i);
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
