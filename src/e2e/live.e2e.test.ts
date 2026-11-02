import { describe, it, expect } from "vitest";
import { createPublicClient, http, parseAbiItem } from "viem";
import { FangornConfig } from "../config.js";

// The only test that touches the real chain, and it only reads it: that the
// configured start block is the DataRegistry's. Everything that writes runs on anvil.

const client = createPublicClient({ transport: http(FangornConfig.rpcUrl) });

describe("Fangorn live deployment (read-only)", () => {
	// Log scans start at `fromBlock`. Too late a block and they miss what came
	// before it, without any error.
	it("the config's start block is at or before the DataRegistry's deployment", async () => {
		const deployed = await client.getLogs({
			address: FangornConfig.dataRegistryContractAddress,
			event: parseAbiItem("event Initialized(uint64 version)"),
			fromBlock: FangornConfig.fromBlock,
			toBlock: FangornConfig.fromBlock + 10n,
		});
		expect(deployed).toHaveLength(1);
	}, 60_000);
});
