import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { FangornConfig } from "../config.js";
import { packCar, readCar } from "../engine/car.js";
import { encodeBlock } from "../engine/records.js";
import { MemStorage } from "../engine/test-helpers.js";
import { Fangorn } from "../fangorn.js";
import { MemLedger, MemRegistry } from "../test/mem-registry.js";

// Audit: "hosts are untrusted; every fetched block is hash-checked". A gateway
// that serves a forged record under the real record's CID — inside the commit's
// CAR, or as a loose commit block — must be caught, not decoded.

async function setup() {
	const ledger = new MemLedger();
	const honest = new MemStorage();
	const sk = generatePrivateKey();
	const pub = Fangorn.create({
		privateKey: sk,
		config: { ...FangornConfig, fromBlock: 0n },
		storage: { backend: honest },
		registry: new MemRegistry(privateKeyToAccount(sk).address, ledger),
	});
	await pub.initRepo("r");
	const { recordCids } = await pub.uploadBatch("r", [
		{ id: "a", type: "t", payload: { secret: "real" } },
	]);
	/** A reader with a cold cache, on a copy of the storage. */
	const reader = (storage: MemStorage) => {
		const rk = generatePrivateKey();
		return Fangorn.create({
			privateKey: rk,
			config: { ...FangornConfig, fromBlock: 0n },
			storage: { backend: storage },
			registry: new MemRegistry(privateKeyToAccount(rk).address, ledger),
		});
	};
	return { pub, honest, recordCid: recordCids.a, reader };
}

const copy = (s: MemStorage) => {
	const c = new MemStorage();
	c.blocks = new Map(s.blocks);
	c.files = new Map(s.files);
	return c;
};

describe("audit: a lying storage gateway", () => {
	it("a forged record inside a CAR, under the real record's CID, is rejected", async () => {
		const { pub, honest, recordCid, reader } = await setup();
		const forged = await encodeBlock({
			id: "a",
			type: "t",
			payload: { secret: "forged" },
		});
		const lying = copy(honest);
		for (const [uri, bytes] of lying.files) {
			const blocks = await readCar(bytes, { verify: false });
			if (!blocks.some((b) => b.cid.toString() === recordCid)) continue;
			const swapped = blocks.map((b) =>
				b.cid.toString() === recordCid
					? { cid: b.cid, bytes: forged.bytes }
					: b,
			);
			lying.files.set(uri, await packCar(blocks[0].cid, swapped));
		}
		const r = reader(lying);
		await expect(
			r.engine.readRecord(pub.getAddress(), "r", "a"),
		).rejects.toThrow(/does not match/);
	});

	it("a forged commit block under the head's CID is rejected", async () => {
		const { pub, honest, reader } = await setup();
		const head = await pub.onChainTip(pub.getAddress(), "r");
		const lying = copy(honest);
		const other = [...honest.blocks.entries()].find(([k]) => k !== head);
		if (!head || !other) throw new Error("setup");
		lying.blocks.set(head, other[1]); // another (valid) commit's bytes
		const r = reader(lying);
		await expect(r.readRepo(pub.getAddress(), "r")).rejects.toThrow(
			/does not match/,
		);
	});
});
