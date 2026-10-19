import { describe, it, expect } from "vitest";
import { FangornEngine, SchemaRegistry } from "./index.js";
import { MemStorage, PUBLISHER, newRegistry, rootHex } from "./test-helpers.js";
import { ZERO_HEAD, epochOf } from "../registry.js";

// The commit model of WHITEPAPER_1 §3.1: γ = (e, parent, root), one repo per
// commit, and a head that moves one commit at a time (Theorem 3).

const rec = (i: number) => ({ id: "0", type: "rec", payload: { i } });

function setup() {
	const registry = newRegistry();
	registry.now = () => 7 * 3600 + 5;
	const engine = new FangornEngine(new MemStorage(), new SchemaRegistry(), registry);
	return { registry, engine };
}

describe("commit model", () => {
	it("a commit is (e, parent, root) for one repo, with root the state tree itself", async () => {
		const { engine } = setup();
		const { commitCid: c1, root } = await engine.createCommit({ repo: "r", base: null, records: [rec(1)], message: "m" });
		const { commitCid: c2 } = await engine.createCommit({ repo: "r", base: c1, records: [rec(2)], message: "m" });

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
		const { commitCid: c1 } = await engine.createCommit({ repo: "r", base: null, records: [rec(1)], message: "m" });
		const { commitCid: c2 } = await engine.createCommit({ repo: "r", base: c1, records: [rec(2)], message: "m" });
		const { commitCid: c3 } = await engine.createCommit({ repo: "r", base: c2, records: [rec(3)], message: "m" });

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
});
