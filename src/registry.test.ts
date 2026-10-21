import { describe, it, expect } from "vitest";
import type { Hex } from "viem";
import { ZERO_HEAD, covers, repoExcluded } from "./registry.js";
import { MemRegistry } from "./test/mem-registry.js";

const P: Hex = "0x0000000000000000000000000000000000000001";
const A: Hex = `0x${"a".repeat(64)}`;
const B: Hex = `0x${"b".repeat(64)}`;
const h = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const ref = { publisher: P, repo: "s" };

describe("MemRegistry (Definition 3.1)", () => {
	it("an update applies once, only while its parent is the head (Theorem 3)", async () => {
		const r = new MemRegistry(P);
		await r.update("s", ZERO_HEAD, h(1));
		await expect(r.update("s", ZERO_HEAD, h(2))).rejects.toThrow(/Stale/);
		await r.update("s", h(1), h(2));
		expect(await r.head(ref)).toBe(h(2));
		expect(await r.head({ publisher: P, repo: "t" })).toBe(ZERO_HEAD);
	});

	it("an app presents exactly the publishers the ledger makes its members", async () => {
		const r = new MemRegistry(P);
		r.ledger.members.add(`${A}/${P}`);
		expect(await r.presents(A, P)).toBe(true);
		expect(await r.presents(B, P)).toBe(false);
	});

	it("exclusions alternate exclude/restore and count each change (Proposition 3.2)", async () => {
		const r = new MemRegistry(P);
		await r.exclude(A, ref);
		await expect(r.exclude(A, ref)).rejects.toThrow();
		expect(await repoExcluded(r, A, ref)).toBe(true);
		expect(await repoExcluded(r, B, ref)).toBe(false);
		await r.restore(A, ref);
		expect(await r.exclusionCount(A, ref)).toBe(2);
		expect(await repoExcluded(r, A, ref)).toBe(false);
	});

	it("an exclusion covers every key of what it names", () => {
		expect(covers({ publisher: P }, ref, "k")).toBe(true);
		expect(covers({ publisher: P, repo: "s" }, ref, "k")).toBe(true);
		expect(covers({ publisher: P, repo: "t" }, ref, "k")).toBe(false);
		expect(covers({ publisher: P, repo: "s", key: "k" }, ref, "k")).toBe(true);
		expect(covers({ publisher: P, repo: "s", key: "j" }, ref, "k")).toBe(false);
	});
});
