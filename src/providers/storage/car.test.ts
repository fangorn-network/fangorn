import { describe, it, expect } from "vitest";
import { CarReader } from "@ipld/car";
import { CID } from "multiformats/cid";
import { packCar } from "./car.js";

describe("packCar", () => {
	it("packs a single item under a directory root and exposes a path URI", async () => {
		const { bytes, root, uriByName } = await packCar([
			{ name: "greeting", data: { hello: "world" } },
		]);

		expect(bytes).toBeInstanceOf(Uint8Array);
		expect(bytes.length).toBeGreaterThan(0);
		expect(uriByName.greeting).toBe(`ipfs://${root.toString()}/greeting`);
	});

	it("produces valid CAR v1 bytes whose sole root is the directory", async () => {
		const { bytes, root } = await packCar([
			{ name: "a", data: "alpha" },
			{ name: "b", data: "beta" },
		]);

		const reader = await CarReader.fromBytes(bytes);
		const roots = await reader.getRoots();
		expect(roots).toHaveLength(1);
		expect(roots[0].toString()).toBe(root.toString());

		// The root block itself must be present in the CAR.
		expect(await reader.has(roots[0])).toBe(true);
	});

	it("sanitizes filesystem-unfriendly characters in entry names", async () => {
		const { root, uriByName } = await packCar([
			{ name: "ns/with/slashes", data: 1 },
		]);
		expect(uriByName["ns/with/slashes"]).toBe(
			`ipfs://${root.toString()}/ns_with_slashes`,
		);
	});

	it("keeps the original name as the map key while sanitizing only the path", async () => {
		const { uriByName } = await packCar([{ name: "a/b", data: 1 }]);
		// Key is the caller's original name; the path segment is sanitized.
		expect(Object.keys(uriByName)).toEqual(["a/b"]);
		expect(uriByName["a/b"]).toMatch(/\/a_b$/);
	});

	it("is deterministic — identical input yields the same root and bytes", async () => {
		const items = [{ name: "x", data: { n: 42 } }];
		const first = await packCar(items);
		const second = await packCar(items);

		expect(second.root.toString()).toBe(first.root.toString());
		expect(second.bytes).toEqual(first.bytes);
	});

	it("returns a real multiformats CID as the root", async () => {
		const { root } = await packCar([{ name: "x", data: 1 }]);
		// Round-tripping through CID.parse proves it is a well-formed CID string.
		expect(CID.parse(root.toString()).toString()).toBe(root.toString());
	});

	it("handles an empty item list", async () => {
		const { bytes, root, uriByName } = await packCar([]);
		expect(uriByName).toEqual({});
		expect(bytes.length).toBeGreaterThan(0);
		const reader = await CarReader.fromBytes(bytes);
		expect((await reader.getRoots())[0].toString()).toBe(root.toString());
	});
});
