import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	DATA_REGISTRY_ABI,
	EMPTY_MMR,
	logLeaf,
	mmrAppend,
	mmrRoot,
} from "../contracts/index.js";
import { chainNetwork, type ChainNetwork, skipChain } from "../test/testbed.js";

// An entry read from the log is the leaf the contract committed to: its
// mountain range root is rebuilt from `log()` alone, and so is a stitch.
describe.skipIf(skipChain)("The update log (contracts on anvil)", () => {
	let net: ChainNetwork;
	beforeAll(async () => {
		net = await chainNetwork();
	}, 120_000);
	afterAll(() => net.stop());

	it("rebuilds the contract's log root, and a stitch verifies against it", async () => {
		const fangorn = await net.client();
		for (const r of ["r1", "r2", "r3"]) await fangorn.initRepo(r);
		const log = await fangorn.getRegistry().log({}, 0n);
		const block = await net.chain.getBlock({ blockNumber: log[0].t });
		expect(log[0].timestamp).toBe(block.timestamp);

		// three leaves: one merge, two peaks
		const root = await net.chain.readContract({
			address: net.config.dataRegistryContractAddress,
			abi: DATA_REGISTRY_ABI,
			functionName: "logRoot",
		});
		expect(mmrRoot(log.map(logLeaf).reduce(mmrAppend, EMPTY_MMR))).toBe(root);

		const stitch = await fangorn.restitch(["*"]);
		expect((await fangorn.readStitch(stitch)).n).toBe(log.length);
		expect(await fangorn.verifyStitch(stitch, ["*"])).toBe(true);
		expect(await fangorn.verifyStitch(stitch, ["r1"])).toBe(false);
	}, 120_000);
});
