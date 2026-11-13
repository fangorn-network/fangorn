import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pad, toHex } from "viem";
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

// Regression: a gas estimate goes stale when other updates land before it.
// Two writers both estimate at log length 2^40 − 2 and land in one block, so
// the second appends at 2^40 − 1: 40 merges and a first write to peaks[40],
// ~120k over its estimate. That used to run out of gas and still report success.
describe.skipIf(skipChain)("Concurrent appends (contracts on anvil)", () => {
	let net: ChainNetwork;
	beforeAll(async () => {
		net = await chainNetwork();
	}, 120_000);
	afterAll(() => net.stop());

	it("land when the log reaches 2^k − 1 after the estimate", async () => {
		const clients = [await net.client(), await net.client()];
		for (const c of clients) await c.initRepo("r");
		// logLength is slot 2 (forge inspect DataRegistry storageLayout)
		await net.chain.setStorageAt({
			address: net.config.dataRegistryContractAddress,
			index: 2,
			value: pad(toHex(2n ** 40n - 2n)),
		});

		await net.chain.setAutomine(false);
		try {
			const writes = clients.map((c) =>
				c.uploadBatch("r", [{ id: "a", type: "note", payload: {} }]),
			);
			while ((await net.chain.getTxpoolStatus()).pending < 2)
				await new Promise((r) => setTimeout(r, 50));
			await net.chain.mine({ blocks: 1 });
			await Promise.all(writes);
		} finally {
			await net.chain.setAutomine(true);
		}

		for (const c of clients) {
			const head = await c
				.getRegistry()
				.headAt({ publisher: c.getAddress(), repo: "r" });
			expect(head.pos).toBe(2);
		}
	}, 120_000);
});
