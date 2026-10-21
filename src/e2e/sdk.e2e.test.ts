import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZERO_HEAD } from "../registry.js";
import { appOf, sdkSuite, head } from "../test/sdk-suite.js";
import { chainNetwork, type ChainNetwork, skipChain } from "../test/testbed.js";

// The SDK suite on the contracts: built from ../contracts/solidity, deployed to
// a fresh anvil. Storage is in memory unless E2E_STORAGE=pinata.
describe.skipIf(skipChain)("Fangorn SDK (contracts on anvil)", () => {
	sdkSuite(chainNetwork, 60_000);
});

// What only the contracts decide: which publishers an app presents. Exactly the ones
// whose storage it provides (`canPublish`), at their latest heads.
describe.skipIf(skipChain)("an app presents its members (contracts on anvil)", () => {
	let net: ChainNetwork;
	beforeAll(async () => {
		net = await chainNetwork();
	}, 120_000);
	afterAll(() => {
		net.stop();
	});

	it("a non-member's update stands, but the app presents nothing of it", async () => {
		await net.client("members");
		const stranger = await net.raw("members");
		await stranger.initRepo("notes");
		await stranger.upload("notes", { n: 1 }, "t", "x");

		const ref = { publisher: stranger.getAddress(), repo: "notes" };
		expect(await head(stranger, "notes")).not.toBe(ZERO_HEAD);
		expect(await stranger.getRegistry().presents(appOf(stranger), ref.publisher)).toBe(false);
		expect((await stranger.readRepo(ref.publisher, "notes")).contents.records).toEqual([]);
	}, 60_000);

	it("a suspended member drops out of the app, and comes back at its latest head", async () => {
		const owner = await net.client("suspend");
		const guest = await net.client("suspend");
		await guest.initRepo("catalog");
		await guest.upload("catalog", { n: 1 }, "t", "a");
		await owner.getAppRegistry().setPublisherSuspended(guest.getAddress(), true);
		expect((await owner.readRepo(guest.getAddress(), "catalog")).contents.records).toEqual([]);
		expect(await owner.appRepos()).toEqual([]);

		// Its updates still land; reinstated, the app presents the latest.
		await guest.upload("catalog", { n: 2 }, "t", "b");
		await owner.getAppRegistry().setPublisherSuspended(guest.getAddress(), false);
		const after = await owner.readRepo(guest.getAddress(), "catalog");
		expect(after.contents.records.map((r) => r.id).sort()).toEqual(["a", "b"]);
	}, 60_000);

	// Apps provide storage: the gate (pinata-url-provider) bills an upload to the app
	// exactly when `access(app, publisher).canPublish` holds.
	it("an app provides its members' storage, and nobody else's", async () => {
		const owner = await net.client("storage");
		const member = await net.client("storage");
		const stranger = await net.raw("storage");
		const apps = owner.getAppRegistry();

		expect((await apps.access(owner.getAddress())).canPublish).toBe(true);
		expect((await apps.access(member.getAddress())).canPublish).toBe(true);
		expect((await apps.access(stranger.getAddress())).canPublish).toBe(false);

		// A publisher that pays for itself is the owner of a one-member app.
		const solo = await net.client(`solo-${stranger.getAddress()}`);
		const own = await solo.getAppRegistry().access(solo.getAddress());
		expect(own.canPublish).toBe(true);
		expect(own.owner).toBe(solo.getAddress());
		expect(own.expiresAt).toBeGreaterThan(0n);
	}, 60_000);
});
