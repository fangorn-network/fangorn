import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PublisherStatus } from "../contracts/index.js";
import type { Fangorn } from "../fangorn.js";
import { chainNetwork, type ChainNetwork, skipChain } from "../test/testbed.js";

// What the protocol admin can do to the network: take an app down, and ban a
// wallet everywhere. On anvil the deployer is the admin, so no real key is ever
// needed and nothing on a real chain is ever suspended.
//
// Not covered, on purpose: fees, registry pointers and upgrades. The contracts
// repo covers them in its Foundry tests.

describe.skipIf(skipChain)("Protocol admin (contracts on anvil)", () => {
	let net: ChainNetwork;
	let owner: Fangorn;
	let guest: Fangorn;
	let admin: Fangorn;

	/** The ids of what `reader` presents of `publisher`'s `repo`. */
	const presented = async (reader: Fangorn, publisher: Fangorn, repo: string) =>
		(await reader.readRepo(publisher.getAddress(), repo)).contents.records.map((r) => r.id).sort();

	beforeAll(async () => {
		net = await chainNetwork();
		owner = await net.client("admin-app");
		guest = await net.client("admin-app");
		admin = await net.raw("admin-app", net.adminKey);
	}, 120_000);

	afterAll(() => {
		net.stop();
	});

	// One level above an owner suspending a member: the app presents nobody, the
	// owner included, and the memberships underneath are left as they were.
	it("an app takedown hides every publisher, and reinstating brings them back", async () => {
		const apps = owner.getAppRegistry();
		const repo = "takedown";
		await guest.initRepo(repo);
		await guest.upload(repo, { n: 1 }, "t", "a");

		await admin.getAppRegistry().setAppSuspended(true);
		expect(await apps.canPublish(owner.getAddress())).toBe(false);
		expect(await apps.canPublish(guest.getAddress())).toBe(false);
		expect(await apps.isAppSuspended()).toBe(true);
		expect(await apps.status(guest.getAddress())).toBe(PublisherStatus.ACTIVE);

		// The guest's own repo moves on; the app presents none of it.
		await guest.upload(repo, { n: 2 }, "t", "b");
		expect(await presented(owner, guest, repo)).toEqual([]);

		await admin.getAppRegistry().setAppSuspended(false);
		expect(await presented(owner, guest, repo)).toEqual(["a", "b"]);
	}, 60_000);

	// The ban is on the wallet: hidden in every app, no storage, and no
	// starting over as an app owner. Lifting it restores everything as it was.
	it("a network-wide ban hides a wallet everywhere until it is lifted", async () => {
		const repo = "banned";
		await guest.initRepo(repo);
		await guest.upload(repo, { n: 1 }, "t", "a");

		await admin.getAppRegistry().setGlobalSuspension(guest.getAddress(), true);
		expect(await guest.getAppRegistry().isGloballySuspended(guest.getAddress())).toBe(true);
		expect(await presented(owner, guest, repo)).toEqual([]);
		expect(await owner.appRepos({ owner: guest.getAddress() })).toEqual([]);

		guest.setAppId("banned-start-over");
		await expect(guest.getAppRegistry().registerApp()).rejects.toThrow(/PublisherSuspendedGlobal/);
		guest.setAppId("admin-app");

		// One wallet's: the owner is still presented.
		await owner.initRepo(repo);
		await owner.upload(repo, { n: 1 }, "t", "o");
		expect(await presented(owner, owner, repo)).toEqual(["o"]);

		await admin.getAppRegistry().setGlobalSuspension(guest.getAddress(), false);
		expect(await presented(owner, guest, repo)).toEqual(["a"]);
		await guest.upload(repo, { n: 2 }, "t", "b");
		expect(await presented(owner, guest, repo)).toEqual(["a", "b"]);
	}, 60_000);

	// Time, not the admin: a lapsed subscription hides the app's publishers like a
	// takedown, and renewing brings them back. Last, since the warp ages every app
	// on this anvil.
	it("an expired app presents nothing until it is renewed", async () => {
		const apps = owner.getAppRegistry();
		const repo = "expiry";
		await guest.initRepo(repo);
		await guest.upload(repo, { n: 1 }, "t", "a");

		const expiresAt = await apps.expiresAt();
		const { timestamp } = await net.chain.getBlock();
		await net.chain.increaseTime({ seconds: Number(expiresAt - timestamp) });
		await net.chain.mine({ blocks: 1 });

		expect(await apps.canPublish(guest.getAddress())).toBe(false);
		await guest.upload(repo, { n: 2 }, "t", "b");
		expect(await presented(owner, guest, repo)).toEqual([]);

		await apps.renewSubscription();
		expect(await apps.expiresAt()).toBeGreaterThan(expiresAt);
		expect(await presented(owner, guest, repo)).toEqual(["a", "b"]);
	}, 60_000);
});
