import { describe, expect, it } from "vitest";
import { parseAgentId, registrationFile } from "./erc8004.js";

describe("erc8004", () => {
	it("writes the file agent0-sdk wrote (Tarot, 84532:10313, as pinned)", () => {
		const card = {
			name: "Tarot",
			description:
				"All 78 tarot cards with keywords, fortunes, and upright and shadow meanings. Ask what a card means, or which card fits a situation.",
			skills: [
				{ tags: ["tarot", "divination"] },
				{ tags: ["tarot", "test", "webmcp"] },
			],
		};
		const cardUrl =
			"https://tarot-test.quickbeam.workers.dev/.well-known/agent-card.json";
		expect(
			JSON.stringify(
				registrationFile({
					cardUrl,
					card,
					chainId: 84532,
					agentId: 10313n,
					now: 1792465356,
				}),
			),
		).toBe(
			JSON.stringify({
				type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
				name: "Tarot",
				description: card.description,
				services: [
					{
						name: "A2A",
						endpoint: cardUrl,
						version: "0.30",
						a2aSkills: ["tarot", "divination", "test", "webmcp"],
					},
				],
				registrations: [
					{
						agentId: 10313,
						agentRegistry:
							"eip155:84532:0x8004A818BFB912233c491871b3d84c89A494BD9e",
					},
				],
				supportedTrust: ["reputation"],
				active: true,
				x402Support: false,
				updatedAt: 1792465356,
			}),
		);
	});

	it("reads x402 off the card and indexes an MCP server after the card", () => {
		const f = registrationFile({
			cardUrl: "https://a.test/card",
			card: { name: "A", description: "a", skills: [{ tags: ["x402"] }, {}] },
			chainId: 421614,
			agentId: 7n,
			mcp: { endpoint: "https://a.test/mcp", tools: ["search"] },
		});
		expect(f.x402Support).toBe(true);
		expect(f.services).toEqual([
			{
				name: "A2A",
				endpoint: "https://a.test/card",
				version: "0.30",
				a2aSkills: ["x402"],
			},
			{
				name: "MCP",
				endpoint: "https://a.test/mcp",
				version: "2025-06-18",
				mcpTools: ["search"],
			},
		]);
	});

	it("parses agent ids and refuses one on another chain", () => {
		expect(parseAgentId("84532:10323", 84532)).toBe(10323n);
		expect(parseAgentId("10323", 84532)).toBe(10323n);
		expect(() => parseAgentId("421614:252", 84532)).toThrow(/chain 421614/);
		expect(() => parseAgentId("abc", 84532)).toThrow(/not an agent id/);
	});
});
