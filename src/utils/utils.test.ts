import { describe, expect, it } from "vitest";
import { CID } from "multiformats/cid";
import { concatBytes, errorMessage, toError } from "./index.js";
import { gatewayUrl, rawBlockRef, RAW_CODE } from "../providers/storage/utils.js";

describe("concatBytes", () => {
	it("joins parts in order", () => {
		expect(
			Array.from(concatBytes([new Uint8Array([1, 2]), new Uint8Array([3])])),
		).toEqual([1, 2, 3]);
	});

	it("returns an empty buffer for no parts", () => {
		expect(concatBytes([]).length).toBe(0);
	});
});

describe("errorMessage / toError", () => {
	it("unwraps Errors and stringifies anything else", () => {
		expect(errorMessage(new Error("boom"))).toBe("boom");
		expect(errorMessage("plain")).toBe("plain");
		expect(errorMessage(undefined)).toBe("");
		expect(toError("plain").message).toBe("plain");
		const err = new Error("kept");
		expect(toError(err)).toBe(err);
	});
});

describe("gatewayUrl", () => {
	it("gives a bare host a scheme and trims trailing slashes", () => {
		expect(gatewayUrl("bafyabc", "foo.mypinata.cloud/")).toBe(
			"https://foo.mypinata.cloud/ipfs/bafyabc",
		);
	});

	it("strips the ipfs:// prefix and falls back to the public gateway", () => {
		expect(gatewayUrl("ipfs://bafyabc/file", "")).toBe(
			"https://ipfs.io/ipfs/bafyabc/file",
		);
	});
});

describe("rawBlockRef", () => {
	it("maps a dag-cbor CID to its raw-codec sibling, digest preserved", () => {
		const dagCborCid =
			"bafyreidykglsfhoixmivffc5uwhcgshx4j465xwqntbmu43nb2dzqwfvae";
		const { fetchCid, isDagCborCid } = rawBlockRef(dagCborCid);

		expect(isDagCborCid).toBe(true);
		const raw = CID.parse(fetchCid);
		expect(raw.code).toBe(RAW_CODE);
		expect(raw.multihash.digest).toEqual(CID.parse(dagCborCid).multihash.digest);
	});

	it("passes through non-dag-cbor and unparseable refs", () => {
		expect(rawBlockRef("bafybeigdyrzt")).toEqual({
			fetchCid: "bafybeigdyrzt",
			isDagCborCid: false,
		});
		expect(rawBlockRef("bafyreinot-a-cid")).toEqual({
			fetchCid: "bafyreinot-a-cid",
			isDagCborCid: true,
		});
	});
});
