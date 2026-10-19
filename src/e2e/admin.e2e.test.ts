import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keccak256, stringToBytes } from "viem";
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

	// One level above an owner suspending a member: everyone's acceptances stop,
	// the owner's included, and the memberships underneath are left as they were.
	it("an app takedown stops every acceptance, and reinstating resumes them", async () => {
		const apps = owner.getAppRegistry();
		const repo = "takedown";
		await guest.initRepo(repo);
		await guest.upload(repo, { n: 1 }, "t", "a");

		await admin.getAppRegistry().suspendApp();
		expect(await apps.isRegisteredForApp(owner.getAddress())).toBe(false);
		expect(await apps.isRegisteredForApp(guest.getAddress())).toBe(false);
		const info = await apps.joinInfo(guest.getAddress());
		expect(info).toMatchObject({ appSuspended: true, registered: false, status: PublisherStatus.ACTIVE });

		// The guest's own repo moves on; the app presents what it had.
		await guest.upload(repo, { n: 2 }, "t", "b");
		expect(await presented(owner, guest, repo)).toEqual(["a"]);

		await admin.getAppRegistry().reinstateApp();
		await guest.upload(repo, { n: 3 }, "t", "c");
		expect(await presented(owner, guest, repo)).toEqual(["a", "b", "c"]);
	}, 60_000);

	// The ban is on the wallet: hidden in every app, no new acceptances, and no
	// starting over as an app owner. Lifting it restores everything as it was.
	it("a network-wide ban hides a wallet everywhere until it is lifted", async () => {
		const repo = "banned";
		await guest.initRepo(repo);
		await guest.upload(repo, { n: 1 }, "t", "a");

		await admin.getAppRegistry().setBanned(guest.getAddress(), true);
		expect(await guest.getAppRegistry().isBanned(guest.getAddress())).toBe(true);
		expect(await presented(owner, guest, repo)).toEqual([]);
		expect(await owner.appRepos({ owner: guest.getAddress() })).toEqual([]);

		guest.setAppId("banned-start-over");
		await expect(
			guest.getAppRegistry().registerApp(keccak256(stringToBytes("terms")), "https://example.test/terms"),
		).rejects.toThrow(/PublisherSuspendedGlobal/);
		guest.setAppId("admin-app");

		// One wallet's: the owner is still presented.
		await owner.initRepo(repo);
		await owner.upload(repo, { n: 1 }, "t", "o");
		expect(await presented(owner, owner, repo)).toEqual(["o"]);

		await admin.getAppRegistry().setBanned(guest.getAddress(), false);
		expect(await presented(owner, guest, repo)).toEqual(["a"]);
		await guest.upload(repo, { n: 2 }, "t", "b");
		expect(await presented(owner, guest, repo)).toEqual(["a", "b"]);
	}, 60_000);
});
