import { describe, it, expect } from "vitest";
import { CID } from "multiformats/cid";
import { FangornEngine, fileCid } from "./index.js";
import { privateKeyToAccount } from "viem/accounts";
import { decodeBlock, encodeBlock } from "./records.js";
import { MemLedger, MemRegistry } from "../test/mem-registry.js";
import { MemStorage, PUBLISHER, newRegistry, rootHex } from "./test-helpers.js";
import { ZERO_HEAD, epochOf } from "../registry.js";

// The commit model of WHITEPAPER_1 §3.1: γ = (e, parent, root), one repo per
// commit, and a head that moves one commit at a time (Theorem 3).

const rec = (i: number) => ({ id: "0", type: "rec", payload: { i } });

function setup() {
	const registry = newRegistry();
	registry.now = () => 7 * 3600 + 5;
	const engine = new FangornEngine(new MemStorage(), registry);
	return { registry, engine };
}

describe("commit model", () => {
	it("a commit is (e, parent, root) for one repo, with root the state tree itself", async () => {
		const { engine } = setup();
		const { commitCid: c1, root } = await engine.createCommit({ repo: "r", base: null, records: [rec(1)] });
		const { commitCid: c2 } = await engine.createCommit({ repo: "r", base: c1, records: [rec(2)] });

		const g1 = await engine.getCommit(c1);
		expect(g1.epoch).toBe(epochOf(7 * 3600 + 5));
		expect(g1.parent).toBeNull();
		expect(g1.root.toString()).toBe(root.toString());
		expect(g1.repo).toBe("r");
		expect((await engine.getCommit(c2)).parent?.toString()).toBe(c1.toString());
		expect(await engine.repoOf(rootHex(c2))).toBe("r");
	});

	it("an update applies only while its parent is the head", async () => {
		const { engine, registry } = setup();
		const { commitCid: c1 } = await engine.createCommit({ repo: "r", base: null, records: [rec(1)] });
		const { commitCid: c2 } = await engine.createCommit({ repo: "r", base: c1, records: [rec(2)] });
		const { commitCid: c3 } = await engine.createCommit({ repo: "r", base: c2, records: [rec(3)] });

		await engine.pushCommit(PUBLISHER, "r", c1);
		// c3 descends from the head, but its parent is c2, not the head
		await expect(engine.pushCommit(PUBLISHER, "r", c3)).rejects.toThrow(/parent/);
		await engine.pushCommit(PUBLISHER, "r", c2);
		await engine.pushCommit(PUBLISHER, "r", c3);

		const log = await registry.log({ repo: "r" }, 0n);
		expect(log.map((e) => [e.parent, e.head])).toEqual([
			[ZERO_HEAD, rootHex(c1)],
			[rootHex(c1), rootHex(c2)],
			[rootHex(c2), rootHex(c3)],
		]);
	});

	it("names its CAR by CID, so the head does not depend on a host", async () => {
		const storage = new MemStorage();
		const engine = new FangornEngine(storage, newRegistry());
		const { commitCid } = await engine.createCommit({ repo: "r", base: null, records: [rec(1)] });
		const raw = decodeBlock<{ car: unknown }>(storage.blocks.get(commitCid.toString()) ?? new Uint8Array());
		expect(CID.asCID(raw.car)).not.toBeNull();
		const { car } = await engine.getCommit(commitCid);
		expect(storage.files.has(car.toString())).toBe(true);
	});

	it("takes a backend's file CID with or without ipfs://", () => {
		const cid = "bafkreidon73zkcrwdb5iafqtijxildoonbwnpv7dyd6ef3qdgads2jc4su";
		expect(fileCid(cid).toString()).toBe(cid);
		expect(fileCid(`ipfs://${cid}`).toString()).toBe(cid);
		expect(() => fileCid("mem://0/x.car")).toThrow(/expected its CID/);
	});

	it("a signed commit is settled by whoever relays it", async () => {
		const account = privateKeyToAccount(`0x${"33".repeat(32)}`);
		const storage = new MemStorage();
		const ledger = new MemLedger();
		const publisher = new FangornEngine(storage, new MemRegistry(account.address, ledger, undefined, account));
		const { commitCid } = await publisher.createCommit({ repo: "r", base: null, records: [rec(1)] });
		const signed = await publisher.signCommit(account.address, "r", commitCid);

		const relayerRegistry = new MemRegistry(PUBLISHER, ledger);
		await new FangornEngine(storage, relayerRegistry).relayCommit(signed);
		expect(await relayerRegistry.head({ publisher: account.address, repo: "r" })).toBe(rootHex(commitCid));
	});

	it("refuses to settle a commit the registry would name differently", async () => {
		const storage = new MemStorage();
		const engine = new FangornEngine(storage, newRegistry());
		const { commitCid } = await engine.createCommit({ repo: "r", base: null, records: [rec(1)] });
		const commit = await engine.getCommit(commitCid);
		// the CAR named by a string rather than a CID link
		const legacy = await encodeBlock({ ...commit, car: commit.car.toString() });
		storage.blocks.set(legacy.cid.toString(), legacy.bytes);
		await expect(engine.pushCommit(PUBLISHER, "r", legacy.cid)).rejects.toThrow(/commit format/);
	});
});
