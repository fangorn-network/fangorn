import { describe, it, expect } from "vitest";
import { createPublicClient, http, parseAbiItem } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { FangornConfig } from "../config.js";
import { Fangorn } from "../fangorn.js";

// The only tests that touch the real chain, and they only read it: that the
// deployed AppRegistry names the configured DataRegistry, and that the public RPC serves
// the log scans the SDK relies on. Everything that writes runs on anvil.

const client = createPublicClient({ transport: http(FangornConfig.rpcUrl) });
// Reading needs no funds, so the wallet is one nobody else has.
const reader = Fangorn.create({ privateKey: generatePrivateKey() });

describe("Fangorn live deployment (read-only)", () => {
	it("the AppRegistry names the configured DataRegistry", async () => {
		expect(await reader.getAppRegistry().dataRegistry()).toBe(FangornConfig.dataRegistryContractAddress);
	}, 60_000);

	// Log scans start at `appRegistryFromBlock`. Too late a block and they miss
	// what came before it, without any error.
	it("the config's start block is the AppRegistry's deployment", async () => {
		const deployed = await client.getLogs({
			address: FangornConfig.appRegistryContractAddress,
			event: parseAbiItem("event Initialized(uint64 version)"),
			fromBlock: FangornConfig.appRegistryFromBlock,
			toBlock: FangornConfig.appRegistryFromBlock,
		});
		expect(deployed).toHaveLength(1);
	}, 60_000);
});
