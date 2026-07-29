import { describe, expect, it } from "vitest";
import { keccak256, toHex } from "viem";

import { namespaceKey, subspaceId } from "./data-registry/index.js";
import { appId } from "../config.js";

// Golden fixture shared with the contract
// (`test_namespace_key_matches_sdk_fixture` in contracts/data_registry).
//
// The client derives this key to filter events and to address heads, and the
// contract derives it to pick a storage slot. If the two ever diverge, reads
// return a zero root and commits land in a slot nobody watches — silently, with
// no revert. Pinning the same constant on both sides is what makes that loud.
const APP = "fangorn";
const NAMESPACE = "docs";
const PUBLISHER = "0x2222222222222222222222222222222222222222" as const;

const APP_ID =
	"0xe9cb5c7e3e8fb962393e314a9387731152c9b2e3cfb1fcbfe79c0c3038b2ed37";
const SUBSPACE_ID =
	"0x6bf9054545420e9e9f4aa4f353a32c7d0d52c11dbcdda56c53be8375cafeebb1";
const NAMESPACE_KEY =
	"0xcfde128f9c8e22771b4caeabe644f7abd0c1d1c50e27562b263934f9279ad3ca";

describe("namespace key derivation", () => {
	it("matches the contract's golden fixture", () => {
		expect(appId(APP)).toBe(APP_ID);
		expect(subspaceId(NAMESPACE)).toBe(SUBSPACE_ID);
		expect(namespaceKey(APP_ID, PUBLISHER, SUBSPACE_ID)).toBe(NAMESPACE_KEY);
	});

	it("hashes names as UTF-8 bytes, not as hex", () => {
		// toHex("docs") is the UTF-8 encoding; a name that looks like hex must not
		// be decoded as one, or "0x1234" and 0x1234 would collide.
		expect(subspaceId("docs")).toBe(keccak256(toHex("docs")));
		expect(subspaceId("0x1234")).not.toBe(keccak256("0x1234"));
	});

	it("separates every part of the triple", () => {
		const other = "0x3333333333333333333333333333333333333333" as const;
		expect(namespaceKey(APP_ID, other, SUBSPACE_ID)).not.toBe(NAMESPACE_KEY);
		expect(namespaceKey(SUBSPACE_ID, PUBLISHER, SUBSPACE_ID)).not.toBe(
			NAMESPACE_KEY,
		);
		expect(namespaceKey(APP_ID, PUBLISHER, APP_ID)).not.toBe(NAMESPACE_KEY);
	});
});
