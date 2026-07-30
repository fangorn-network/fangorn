import { describe, expect, it } from "vitest";
import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { blockMatchesCid, encodeBlock } from "./graph.js";
import { assertValidNamespace } from "./index.js";
import { gatewayUrl } from "../providers/storage/utils.js";

describe("blockMatchesCid", () => {
	it("accepts bytes that hash to the CID", async () => {
		const block = await encodeBlock({ hello: "world" });
		await expect(blockMatchesCid(block.cid, block.bytes)).resolves.toBe(true);
	});

	it("rejects substituted bytes served under someone else's CID", async () => {
		const honest = await encodeBlock({ hello: "world" });
		const forged = dagCbor.encode({ hello: "evil" });
		await expect(blockMatchesCid(honest.cid, forged)).resolves.toBe(false);
	});

	it("rejects a CID whose multihash is not sha256", async () => {
		const bytes = dagCbor.encode({ hello: "world" });
		const digest = await sha256.digest(bytes);
		const identityLike = CID.createV1(dagCbor.code, {
			...digest,
			code: 0x00,
		});
		await expect(blockMatchesCid(identityLike, bytes)).resolves.toBe(false);
	});
});

describe("assertValidNamespace", () => {
	it("allows hierarchical names", () => {
		expect(() => { assertValidNamespace("docs/recipes"); }).not.toThrow();
	});

	it("rejects relative path segments and control characters", () => {
		expect(() => { assertValidNamespace("../../etc/passwd"); }).toThrow();
		expect(() => { assertValidNamespace("docs/../..") }).toThrow();
		expect(() => { assertValidNamespace("docs\u0000evil"); }).toThrow();
	});
});

describe("gatewayUrl", () => {
	it("builds a gateway URL for a bare CID and a path-style URI", () => {
		expect(gatewayUrl("https://ipfs.io", "bafyfake")).toBe(
			"https://ipfs.io/ipfs/bafyfake",
		);
		expect(gatewayUrl("gw.mypinata.cloud", "ipfs://bafyfake/data.car")).toBe(
			"https://gw.mypinata.cloud/ipfs/bafyfake/data.car",
		);
	});

	it("refuses paths that would escape the gateway", () => {
		expect(() => gatewayUrl("https://ipfs.io", "../../admin")).toThrow();
		expect(() => gatewayUrl("https://ipfs.io", "ipfs://bafy/../../secret")).toThrow();
		expect(() => gatewayUrl("https://ipfs.io", "http://evil.example/x")).toThrow();
		expect(() => gatewayUrl("https://ipfs.io", "//evil.example/x")).toThrow();
	});
});
