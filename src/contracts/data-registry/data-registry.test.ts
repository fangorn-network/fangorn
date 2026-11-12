import { describe, it, expect } from "vitest";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
	EPOCH_SECONDS,
	WINDOW,
	ZERO_HEAD,
	type CommitUpdate,
} from "./index.js";
import { MemRegistry } from "../../test/mem-registry.js";
import { commitHead } from "../../engine/index.js";

const P: Hex = "0x0000000000000000000000000000000000000001";
const ref = { publisher: P, repo: "s" };

// The commits DataRegistry.t.sol checks `commitHead` against.
const E = 493_000;
const ROOT: Hex =
	"0xc3a75f27a0777dd37f80e7252ba50f882a088dd9b6e3e602281b9c217375cd9f";
const DIFF: Hex = `0x${"11".repeat(32)}`;
const CAR: Hex =
	"0x01551220039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
const FIRST: Hex =
	"0x96e5fb518a2070784f5c2920494d35c7585a7c3ebf0e11c48138ff607d4f499f";
const SECOND: Hex =
	"0xd4d5aecb442c8e8c510ea16de16af34726babf069c375356b50468be21998242";
const LONG: Hex =
	"0x25028509d1c083e454d4dbc6840c45b88354603a44a96683298c26557bf6fd8a";
const SMALL: Hex =
	"0xb3f8e42d45c2f0db59f96985b4528e253c855a01db88631ef84ed5182d584ef1";

const u = (
	repo: string,
	epoch: number,
	parent: Hex = ZERO_HEAD,
): CommitUpdate => ({ repo, epoch, parent, diff: DIFF, root: ROOT, car: CAR });
const at = (epoch: number) => () => epoch * EPOCH_SECONDS + 5;

describe("commitHead", () => {
	it("matches the contract's fixtures", async () => {
		expect(await commitHead(u("photos", E))).toBe(FIRST);
		expect(await commitHead(u("photos", E + 1, FIRST))).toBe(SECOND);
		expect(await commitHead(u("r".repeat(256), 7, FIRST))).toBe(LONG);
		expect(await commitHead(u("a", 23))).toBe(SMALL);
	});
});

describe("MemRegistry (Definition 3.1)", () => {
	it("an update applies once, only while its parent is the head (Theorem 3)", async () => {
		const r = new MemRegistry(P, undefined, at(E + 1));
		await r.update(u("s", E));
		const first = await commitHead(u("s", E));
		expect(await r.head(ref)).toBe(first);
		await expect(r.update(u("s", E))).rejects.toThrow(/Stale/);
		await r.update(u("s", E + 1, first));
		expect(await r.head(ref)).toBe(await commitHead(u("s", E + 1, first)));
		expect(await r.head({ publisher: P, repo: "t" })).toBe(ZERO_HEAD);
	});

	it("takes a commit's epoch only within the window", async () => {
		const r = new MemRegistry(P, undefined, at(E));
		await expect(r.update(u("a", E + 1))).rejects.toThrow(/Epoch/);
		await expect(r.update(u("a", E - WINDOW - 1))).rejects.toThrow(/Epoch/);
		await r.update(u("a", E - WINDOW));
		await r.update(u("b", E));
	});

	it("updateBySig moves the signer's repo, whoever submits it", async () => {
		const account = privateKeyToAccount(`0x${"22".repeat(32)}`);
		const publisher = new MemRegistry(
			account.address,
			undefined,
			at(E),
			account,
		);
		const relayer = new MemRegistry(P, publisher.ledger, at(E));
		const sig = await publisher.signUpdate(u("photos", E));
		await relayer.updateBySig(account.address, u("photos", E), sig);
		expect(
			await relayer.head({ publisher: account.address, repo: "photos" }),
		).toBe(FIRST);
		expect(await relayer.head({ publisher: P, repo: "photos" })).toBe(
			ZERO_HEAD,
		);
		await expect(
			relayer.updateBySig(account.address, u("photos", E), sig),
		).rejects.toThrow(/Stale/);
	});

	it("updateBySig rejects a changed field or another signer", async () => {
		const account = privateKeyToAccount(`0x${"22".repeat(32)}`);
		const r = new MemRegistry(account.address, undefined, at(E), account);
		const sig = await r.signUpdate(u("photos", E));
		await expect(
			r.updateBySig(account.address, u("videos", E), sig),
		).rejects.toThrow(/BadSignature/);
		await expect(
			r.updateBySig(account.address, { ...u("photos", E), root: FIRST }, sig),
		).rejects.toThrow(/BadSignature/);
		await expect(r.updateBySig(P, u("photos", E), sig)).rejects.toThrow(
			/BadSignature/,
		);
	});
});
