import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Hex } from "viem";
import { CARD_RECORD, FANGORN_REPO_EXTENSION } from "../fangorn.js";
import { chainNetwork, type ChainNetwork, skipChain } from "../test/testbed.js";

// A repo's agent card: the publisher commits `@card` pointing at it, and a
// reader holding only the card URL finds the repo. Trust comes from the record,
// which only the publisher can commit, not from the transport.
describe.skipIf(skipChain)("Repo agent cards (contracts on anvil)", () => {
	const REPO = "catalog";
	const cards: Record<string, unknown> = {};
	let server: Server;
	let origin: string;
	let net: ChainNetwork;

	const card = (publisher: Hex, repo: string) => ({
		protocolVersion: "0.3.0",
		name: "E2E Fangorn repo",
		description: "a repo found from its card",
		url: origin,
		capabilities: {
			extensions: [
				{
					uri: FANGORN_REPO_EXTENSION,
					params: { chainId: net.config.caip2, dataRegistry: net.config.dataRegistryContractAddress, publisher, repo },
				},
			],
		},
		skills: [],
	});

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

	it("binds a card, and a reader finds the repo's data from the card alone", async () => {
		const owner = await net.client();
		await owner.initRepo(REPO);
		await owner.upload(REPO, { title: "hello from the repo" }, "entry", "e1");

		const cardUrl = `${origin}/.well-known/agent-card.json`;
		cards["/.well-known/agent-card.json"] = card(owner.getAddress(), REPO);
		const bound = await owner.registerAgent(cardUrl, { repo: REPO, skipRegister: true });
		expect(bound.txHash).toBeDefined();
		expect(await owner.cardOf(owner.getAddress(), REPO)).toBe(cardUrl);
		// Already bound: nothing is committed.
		expect((await owner.registerAgent(cardUrl, { repo: REPO, skipRegister: true })).txHash).toBeUndefined();

		// A stranger holding only the URL.
		const reader = await net.client();
		const found = await reader.discoverCard(cardUrl);
		expect(found).toMatchObject({ publisher: owner.getAddress(), repo: REPO });
		const { contents } = await reader.readRepo(found.publisher, found.repo);
		expect(contents.records.map((r) => r.id).sort()).toEqual([CARD_RECORD, "e1"]);
	}, 60_000);

	// Anyone can serve a card naming any repo; only the publisher commits `@card`.
	it("rejects a card its repo doesn't point back at", async () => {
		const owner = await net.client();
		cards["/forged.json"] = card(owner.getAddress(), "never-written");
		const reader = await net.client();
		await expect(reader.discoverCard(`${origin}/forged.json`)).rejects.toThrow(/not bound/);
	}, 60_000);
});
