import { describe, it, expect } from "vitest";
import { keccak256, toHex } from "viem";
import { arbitrumSepolia } from "viem/chains";
import getNetwork, {
	appId,
	toAppId,
	DEFAULT_APP,
	FangornConfig,
	SupportedNetworks,
} from "./config.js";

describe("appId", () => {
	it("derives the keccak256 of the hex-encoded name", () => {
		expect(appId("fangorn")).toBe(keccak256(toHex("fangorn")));
	});

	it("is a 32-byte hex string", () => {
		expect(appId("anything")).toMatch(/^0x[0-9a-f]{64}$/);
	});

	it("is deterministic and collision-free across distinct names", () => {
		expect(appId("a")).toBe(appId("a"));
		expect(appId("a")).not.toBe(appId("b"));
	});
});

describe("toAppId", () => {
	it("passes an already-derived 32-byte app id through unchanged", () => {
		const id = appId(DEFAULT_APP);
		expect(toAppId(id)).toBe(id);
	});

	it("derives an id from a human-readable name", () => {
		expect(toAppId("fangorn")).toBe(appId("fangorn"));
	});

	it("treats a too-short hex string as a name, not an id", () => {
		const shortHex = "0x1234";
		expect(toAppId(shortHex)).toBe(appId(shortHex));
	});
});

describe("getNetwork", () => {
	it("returns the arbitrumSepolia chain for its name", () => {
		expect(getNetwork(SupportedNetworks.ArbitrumSepolia.name)).toBe(
			arbitrumSepolia,
		);
	});

	it("throws for an unsupported chain name", () => {
		expect(() => getNetwork("mainnet")).toThrow(
			/Chain mainnet is not supported/,
		);
	});

	it("throws for baseSepolia, which is declared but not yet wired up", () => {
		expect(() => getNetwork(SupportedNetworks.BaseSepolia.name)).toThrow(
			/not supported/,
		);
	});
});

describe("FangornConfig defaults", () => {
	it("targets arbitrum sepolia with matching caip2 and a public gateway", () => {
		expect(FangornConfig.chain).toBe(arbitrumSepolia);
		expect(FangornConfig.caip2).toBe(421614);
		expect(FangornConfig.ipfsGateway).toMatch(/^https:\/\//);
		expect(FangornConfig.dataRegistryContractAddress).toMatch(/^0x[0-9a-f]+$/i);
	});
});
