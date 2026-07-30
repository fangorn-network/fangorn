import { describe, it, expect, vi, afterEach } from "vitest";
import { getRandomValues, getSubtleCrypto } from "./rand.js";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("getSubtleCrypto", () => {
	it("returns the Node webcrypto subtle implementation", () => {
		const subtle = getSubtleCrypto();
		expect(subtle).toBe(globalThis.crypto.subtle);
		expect(typeof subtle.digest).toBe("function");
	});
});

describe("getRandomValues", () => {
	it("fills the array in place and returns the same reference", () => {
		const array = new Uint8Array(16);
		const returned = getRandomValues(array);
		expect(returned).toBe(array);
	});

	it("writes random bytes (overwrites the zero-filled input)", () => {
		const array = new Uint8Array(32);
		getRandomValues(array);
		// A 32-byte CSPRNG draw being all zeros is astronomically unlikely.
		expect(array.some((b) => b !== 0)).toBe(true);
	});

	it("delegates to the platform crypto.getRandomValues", () => {
		const spy = vi.spyOn(globalThis.crypto, "getRandomValues");
		const array = new Uint8Array(8);
		getRandomValues(array);
		expect(spy).toHaveBeenCalledWith(array);
	});
});
