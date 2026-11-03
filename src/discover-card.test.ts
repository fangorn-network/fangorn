import { describe, it, expect, vi, afterEach } from "vitest";
import { Fangorn, FANGORN_REPO_EXTENSION } from "./fangorn.js";
import { FangornConfig } from "./config.js";

const CARD_URL = "https://app.example/.well-known/agent-card.json";
const PUBLISHER = "0x147c24c5Ea2f1EE1ac42AD16820De23bBba45Ef6";

function cardWith(params: Record<string, unknown>) {
	return {
		name: "Test",
		capabilities: {
			extensions: [
				{
					uri: FANGORN_REPO_EXTENSION,
					params: {
						chainId: FangornConfig.caip2,
						dataRegistry: FangornConfig.dataRegistryContractAddress,
						publisher: PUBLISHER,
						repo: "catalog",
						...params,
					},
				},
			],
		},
	};
}

/** Serve `body` from fetch and answer the repo's `@card` record with `bound` (null: none). */
function setup(body: unknown, bound: string | null = CARD_URL, status = 200) {
	vi.stubGlobal(
		"fetch",
		vi.fn(() =>
			Promise.resolve(new Response(JSON.stringify(body), { status })),
		),
	);
	// Throwaway key: discoverCard never signs, and the record read is stubbed.
	const f = Fangorn.create({
		privateKey: `0x${"11".repeat(32)}`,
		config: FangornConfig,
	});
	const cardOf = vi.spyOn(f, "cardOf").mockResolvedValue(bound ?? undefined);
	return { f, cardOf };
}

describe("discoverCard", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("resolves a card its repo points back at", async () => {
		const card = cardWith({});
		const { f, cardOf } = setup(card);
		expect(await f.discoverCard(CARD_URL)).toEqual({
			card,
			publisher: PUBLISHER,
			repo: "catalog",
		});
		expect(cardOf).toHaveBeenCalledWith(PUBLISHER, "catalog");
	});

	it("accepts a registry address in any case", async () => {
		const { f } = setup(
			cardWith({
				dataRegistry: FangornConfig.dataRegistryContractAddress.toLowerCase(),
			}),
		);
		await expect(f.discoverCard(CARD_URL)).resolves.toMatchObject({
			repo: "catalog",
		});
	});

	it("rejects a card that cannot be fetched", async () => {
		const { f } = setup({}, CARD_URL, 404);
		await expect(f.discoverCard(CARD_URL)).rejects.toThrow(/HTTP 404/);
	});

	it("rejects a card with no Fangorn extension", async () => {
		const { f, cardOf } = setup({
			name: "plain A2A agent",
			capabilities: { extensions: [{ uri: "https://other/ext" }] },
		});
		await expect(f.discoverCard(CARD_URL)).rejects.toThrow(/no .* extension/);
		expect(cardOf).not.toHaveBeenCalled();
	});

	it.each([
		["publisher missing", { publisher: undefined }, /publisher/],
		["publisher short", { publisher: "0x1234" }, /publisher/],
		["repo missing", { repo: undefined }, /repo/],
		["repo empty", { repo: "" }, /repo/],
	])("rejects a malformed extension: %s", async (_, params, error) => {
		const { f, cardOf } = setup(cardWith(params));
		await expect(f.discoverCard(CARD_URL)).rejects.toThrow(error);
		expect(cardOf).not.toHaveBeenCalled();
	});

	it.each([
		["another chain", { chainId: 1 }],
		["chainId as a string", { chainId: String(FangornConfig.caip2) }],
		["another DataRegistry", { dataRegistry: `0x${"ab".repeat(20)}` }],
		["no DataRegistry", { dataRegistry: undefined }],
	])("rejects a card for a different deployment: %s", async (_, params) => {
		const { f, cardOf } = setup(cardWith(params));
		await expect(f.discoverCard(CARD_URL)).rejects.toThrow(/not this client's/);
		expect(cardOf).not.toHaveBeenCalled();
	});

	it.each([
		["repo has no card", null],
		[
			"repo bound to another card",
			"https://elsewhere.example/.well-known/agent-card.json",
		],
		// Exact match on purpose: no URL normalization to widen what counts as the card.
		["trailing slash differs", `${CARD_URL}/`],
	])("rejects a card its repo does not point back at: %s", async (_, bound) => {
		const { f } = setup(cardWith({}), bound);
		await expect(f.discoverCard(CARD_URL)).rejects.toThrow(/not bound to/);
	});
});
