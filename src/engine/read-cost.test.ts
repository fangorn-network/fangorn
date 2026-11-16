import { describe, it, expect } from "vitest";
import { FangornEngine } from "./index.js";
import { MemStorage, PUBLISHER, newRegistry } from "./test-helpers.js";

// A cold read walks back one CAR per commit until it finds a block. Checkpoint
// commits (a full CAR) cap that walk, so reading an old record stays cheap.

async function readFirstCost(n: number, every?: number) {
	const storage = new MemStorage();
	const registry = newRegistry();
	const writer = new FangornEngine(storage, registry);
	let base = null;
	for (let i = 0; i < n; i++) {
		const { commitCid } = await writer.createCommit({
			repo: "r",
			base,
			records: [{ id: `a${i.toString()}`, type: "t", payload: { i } }],
			checkpoint: every !== undefined && i % every === every - 1,
		});
		await writer.pushCommit(PUBLISHER, "r", commitCid);
		base = commitCid;
	}
	storage.reads = 0;
	const rec = await new FangornEngine(storage, registry).readRecord(
		PUBLISHER,
		"r",
		"a0",
	);
	expect(rec?.payload).toEqual({ i: 0 });
	return storage.reads;
}

describe("cold read cost", () => {
	it("grows with commit age without checkpoints", async () => {
		expect(await readFirstCost(60)).toBeGreaterThan(100);
	});

	it("is capped by checkpoints", async () => {
		expect(await readFirstCost(60, 10)).toBeLessThanOrEqual(2 * 10 + 2);
	});

	it("is null for a repo with no commits", async () => {
		const e = new FangornEngine(new MemStorage(), newRegistry());
		expect(await e.readRecord(PUBLISHER, "none", "a")).toBeNull();
	});
});
