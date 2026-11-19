import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DATA_REGISTRY_ABI } from "../contracts/index.js";
import type { UpdateEntry } from "../contracts/index.js";
import { chainNetwork, type ChainNetwork, skipChain } from "../test/testbed.js";

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Regression: watch() once ran one viem watch per event version. viem keys a watch by
// address/eventName/args/interval but not its abi, so the two shared one poller with the
// first (old) abi: on the current contracts no live entry arrived at all, and next to
// another same-key watch every entry arrived twice.
describe.skipIf(skipChain)("ChainRegistry.watch (contracts on anvil)", () => {
	let net: ChainNetwork;
	beforeAll(async () => {
		net = await chainNetwork();
	}, 120_000);
	afterAll(() => net.stop());

	it("delivers each live update exactly once, filtered by publisher and repo", async () => {
		const pub = await net.client();
		const other = await net.client();
		await pub.initRepo("w");
		await other.initRepo("w");
		const registry = pub.getRegistry();
		const all: UpdateEntry[] = [];
		const mine: UpdateEntry[] = [];
		const errs: unknown[] = [];
		// a raw watch with the key viem would have collapsed ours into
		const raw = net.chain.watchContractEvent({
			address: net.config.dataRegistryContractAddress,
			abi: DATA_REGISTRY_ABI,
			eventName: "Updated",
			args: {},
			strict: true,
			pollingInterval: 100,
			onLogs: () => undefined,
		});
		const stops = [
			registry.watch(
				{},
				(e) => all.push(e),
				(e) => errs.push(e),
				100,
			),
			registry.watch(
				{ publisher: pub.getAddress(), repo: "w" },
				(e) => mine.push(e),
				(e) => errs.push(e),
				100,
			),
		];
		await settle(500);
		await pub.upload("w", { n: 1 }, "t", "a");
		await other.upload("w", { n: 1 }, "t", "a");
		await settle(2_000);
		raw();
		for (const s of stops) s();

		expect(errs).toEqual([]);
		expect(all.map((e) => [e.publisher, e.pos])).toEqual([
			[pub.getAddress(), 2],
			[other.getAddress(), 2],
		]);
		expect(mine.map((e) => [e.publisher, e.repo, e.pos])).toEqual([
			[pub.getAddress(), "w", 2],
		]);
		// new-version entries carry the event's own timestamp
		expect(mine[0].timestamp).toBeGreaterThan(0n);
	}, 120_000);
});
