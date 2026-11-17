import { describe, it, expect } from "vitest";
import { zeroAddress } from "viem";
import getNetwork, {
	ArbitrumConfig,
	BaseConfig,
	SupportedNetworks,
} from "./config.js";
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

	it("gives each network its own key server and upload worker", () => {
		// A key server answers for one SettlementRegistry: sharing one across networks
		// would seal deposits a buyer on the other network can never open. Either is
		// optional (mainnet runs neither yet), but a key server comes with a registry.
		const nets = Object.values(SupportedNetworks);
		for (const c of nets)
			expect(Boolean(c.keyServer)).toBe(Boolean(c.settlementRegistryContractAddress));
		for (const field of ["keyServer", "signedUrlWorker"] as const) {
			const urls = nets.map((c) => c[field]).filter(Boolean);
			expect(new Set(urls).size).toBe(urls.length);
		}
	});

	it("keeps paid records off on mainnet", () => {
		for (const c of [BaseConfig, ArbitrumConfig]) {
			expect(c).not.toHaveProperty("settlementRegistryContractAddress");
			expect(c).not.toHaveProperty("keyServer");
			expect(IDENTITY_REGISTRY[c.caip2]).toBeDefined();
		}
	});

	it("refuses an unknown name, listing the supported ones", () => {
		expect(() => getNetwork("mainnet")).toThrow(/baseSepolia, arbitrumSepolia/);
	});
});
