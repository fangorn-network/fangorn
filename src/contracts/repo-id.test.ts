import { describe, expect, it } from "vitest";
import { keccak256, toHex } from "viem";

import { repoId } from "./data-registry/index.js";
import { appId } from "../config.js";

// Golden fixture shared with the contracts (`test_repo_id_matches_sdk_fixture` in
// contracts/solidity/test/DataRegistry.t.sol). If the derivations diverge, every
// head reads as zero and every update lands where nobody watches — silently.
describe("id derivation", () => {
	it("matches the contract's golden fixture", () => {
		expect(appId("fangorn")).toBe("0xe9cb5c7e3e8fb962393e314a9387731152c9b2e3cfb1fcbfe79c0c3038b2ed37");
		expect(repoId("docs")).toBe("0x6bf9054545420e9e9f4aa4f353a32c7d0d52c11dbcdda56c53be8375cafeebb1");
	});

	it("hashes names as UTF-8 bytes, not as hex", () => {
		// a name that looks like hex must not be decoded as one, or "0x1234" and 0x1234 collide
		expect(repoId("0x1234")).toBe(keccak256(toHex("0x1234")));
		expect(repoId("0x1234")).not.toBe(keccak256("0x1234"));
	});
});
