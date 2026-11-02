import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Fangorn } from "../fangorn.js";
import { chainNetwork, type ChainNetwork, skipChain } from "../test/testbed.js";

// The protocol admin can take an app's name down. On anvil the deployer is the
// admin, so no real key is needed. Upgrades and token withdrawals are covered by
// the contracts' Foundry tests.

describe.skipIf(skipChain)("Protocol admin (contracts on anvil)", () => {
	let net: ChainNetwork;
	let owner: Fangorn;
	let admin: Fangorn;

	beforeAll(async () => {
		net = await chainNetwork();
		owner = await net.raw("admin-app");
		await owner.getAppRegistry().registerApp();
		admin = await net.raw("admin-app", net.adminKey);
	}, 120_000);

	afterAll(() => {
		net.stop();
	});

	it("only the admin suspends an app, and reinstates it", async () => {
		const apps = owner.getAppRegistry();
		await expect(apps.setAppSuspended(true)).rejects.toThrow(/Unauthorized/);

		await admin.getAppRegistry().setAppSuspended(true);
		expect(await apps.isAppSuspended()).toBe(true);
		await admin.getAppRegistry().setAppSuspended(false);
		expect(await apps.isAppSuspended()).toBe(false);
	}, 60_000);

	it("a suspension changes nothing a publisher committed", async () => {
		await owner.initRepo("kept");
		await owner.upload("kept", { n: 1 }, "t", "a");
		await admin.getAppRegistry().setAppSuspended(true);
		const { contents } = await owner.readRepo(owner.getAddress(), "kept");
		expect(contents.records.map((r) => r.id)).toEqual(["a"]);
		await admin.getAppRegistry().setAppSuspended(false);
	}, 60_000);
});
