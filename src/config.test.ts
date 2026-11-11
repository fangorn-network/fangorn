import { describe, it, expect } from "vitest";
import { zeroAddress } from "viem";
import getNetwork, { SupportedNetworks } from "./config.js";
import { IDENTITY_REGISTRY } from "./erc8004.js";

describe("supported networks", () => {
	// Guards publishing a network whose deployment was never filled in: the SDK would
	// read nothing and sign for a zero-address registry.
	for (const [name, c] of Object.entries(SupportedNetworks)) {
		it(`${name} names a real deployment`, () => {
			expect(c.dataRegistryContractAddress).not.toBe(zeroAddress);
			expect(c.settlementRegistryContractAddress).not.toBe(zeroAddress);
			expect(c.fromBlock).toBeGreaterThan(0n);
			expect(c.chain.id).toBe(c.caip2);
			expect(IDENTITY_REGISTRY[c.caip2]).toBeDefined();
			expect(getNetwork(name)).toBe(c);
		});
	}

	it("refuses an unknown name, listing the supported ones", () => {
		expect(() => getNetwork("mainnet")).toThrow(/baseSepolia, arbitrumSepolia/);
	});
});
