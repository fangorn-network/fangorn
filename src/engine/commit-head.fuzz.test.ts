import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { readFileSync } from "fs";
import { sha256 } from "@noble/hashes/sha2.js";
import {
	bytesToHex,
	concat,
	decodeAbiParameters,
	encodeAbiParameters,
	hexToBytes,
	keccak256,
	numberToBytes,
	type Hex,
} from "viem";
import { cidFromDigest, commitHead, commitUpdate } from "./index.js";
import { ZERO_HEAD, repoId, type CommitUpdate } from "../contracts/index.js";
import { decodeBlock, encodeBlock, type CommitBlock } from "./records.js";
import { CID } from "multiformats/cid";

// DataRegistry.commitHead, re-derived here from the Solidity source alone (not from the SDK's
// encoder), checked against the contract's own output (forge, commit-head.vectors.json) and
// then fuzzed against the SDK's `commitHead`. FUZZ_RUNS=<n> for a longer campaign.

const runs = Number(process.env.FUZZ_RUNS ?? 200);

// ── Reference: a line-for-line port of DataRegistry.sol ─────────────────────

const UINT = 0,
	BYTES = 2,
	TEXT = 3,
	MAP = 5;

/** `_cborHead`: the shortest-form ladder 24 / 2^8 / 2^16 / 2^32. */
function cborHead(major: number, n: bigint): Uint8Array {
	const m = major << 5;
	if (n < 24n) return new Uint8Array([m | Number(n)]);
	if (n < 1n << 8n)
		return concat([new Uint8Array([m | 0x18]), numberToBytes(n, { size: 1 })]);
	if (n < 1n << 16n)
		return concat([new Uint8Array([m | 0x19]), numberToBytes(n, { size: 2 })]);
	if (n < 1n << 32n)
		return concat([new Uint8Array([m | 0x1a]), numberToBytes(n, { size: 4 })]);
	return concat([new Uint8Array([m | 0x1b]), numberToBytes(n, { size: 8 })]);
}
const text = (b: Uint8Array) => concat([cborHead(TEXT, BigInt(b.length)), b]);
const key = (s: string) => text(new TextEncoder().encode(s));
const link = (cid: Uint8Array) =>
	concat([
		hexToBytes("0xd82a"),
		cborHead(BYTES, BigInt(cid.length + 1)),
		new Uint8Array([0]),
		cid,
	]);
const dagCborCid = (digest: Hex) =>
	concat([hexToBytes("0x01711220"), hexToBytes(digest)]);

function refCommitHead(
	repo: Uint8Array,
	epoch: bigint,
	parent: Hex,
	diff: Hex,
	root: Hex,
	car: Uint8Array,
): Hex {
	return bytesToHex(
		sha256(
			concat([
				cborHead(MAP, 6n),
				key("car"),
				link(car),
				key("diff"),
				link(dagCborCid(diff)),
				key("repo"),
				text(repo),
				key("root"),
				link(dagCborCid(root)),
				key("epoch"),
				cborHead(UINT, epoch),
				key("parent"),
				parent === ZERO_HEAD
					? new Uint8Array([0xf6])
					: link(dagCborCid(parent)),
			]),
		),
	);
}

/** The bytes `bytes(repo)` sees: the string as viem ABI-encodes it into calldata. */
const calldataBytes = (repo: string) =>
	hexToBytes(
		decodeAbiParameters(
			[{ type: "bytes" }],
			encodeAbiParameters([{ type: "string" }], [repo]),
		)[0],
	);

// ── The grid forge ran (contracts' Vectors.t.sol, in the audit scratchpad) ──

const rep = (unit: number[], n: number) =>
	new Uint8Array(
		Array.from({ length: unit.length * n }, (_, i) => unit[i % unit.length]),
	);
const R = "r".charCodeAt(0);
const REPOS: Uint8Array[] = [
	new Uint8Array(),
	new TextEncoder().encode("a"),
	rep([R], 23),
	rep([R], 24),
	rep([R], 255),
	rep([R], 256),
	rep([R], 65535),
	rep([R], 65536),
	hexToBytes("0xc3a9"), // é (NFC)
	hexToBytes("0x65cc81"), // e + U+0301 (NFD)
	hexToBytes("0x61ff"), // invalid UTF-8
	hexToBytes("0xf09f8cb3"), // 🌳
	hexToBytes("0xeda080"), // an encoded surrogate: invalid UTF-8
	rep([0xe6, 0x97, 0xa5], 86), // 258 bytes, 86 chars
];
const EPOCHS = [
	0n,
	23n,
	24n,
	255n,
	256n,
	65535n,
	65536n,
	2n ** 32n - 1n,
	2n ** 32n,
	2n ** 53n - 1n,
	2n ** 53n,
	2n ** 64n - 1n,
	493000n,
];
const CARS = [
	"0x01551220039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
	"0x1220039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81", // CIDv0
	"0x01711220039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
] as const;
const tagged = (tag: string, k: number) =>
	keccak256(
		encodeAbiParameters(
			[{ type: "string" }, { type: "uint256" }],
			[tag, BigInt(k)],
		),
	);

const grid = REPOS.flatMap((repo, i) =>
	EPOCHS.map((epoch, j) => {
		const k = i * EPOCHS.length + j + 1;
		return {
			repo,
			epoch,
			parent: k % 2 === 0 ? ZERO_HEAD : tagged("p", k),
			diff: tagged("d", k),
			root: tagged("r", k),
			car: CARS[k % 3],
		};
	}),
);
const VECTORS = JSON.parse(
	readFileSync(new URL("./commit-head.vectors.json", import.meta.url), "utf8"),
) as { heads: Hex[] };

const utf8 = (b: Uint8Array) => {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(b);
	} catch {
		return null;
	}
};

describe("commitHead vs DataRegistry.commitHead", () => {
	it("the reference port reproduces every forge vector", () => {
		expect(VECTORS.heads).toHaveLength(grid.length);
		grid.forEach((g, n) => {
			expect(
				refCommitHead(
					g.repo,
					g.epoch,
					g.parent,
					g.diff,
					g.root,
					hexToBytes(g.car),
				),
			).toBe(VECTORS.heads[n]);
		});
	});

	it("the SDK reproduces every forge vector it can express (valid UTF-8 repo, safe-integer epoch)", async () => {
		let checked = 0;
		for (const [n, g] of grid.entries()) {
			const repo = utf8(g.repo);
			if (repo === null || g.epoch > BigInt(Number.MAX_SAFE_INTEGER)) continue;
			const u: CommitUpdate = { ...g, repo, epoch: Number(g.epoch) };
			expect(await commitHead(u)).toBe(VECTORS.heads[n]);
			checked++;
		}
		expect(checked).toBe(12 * 11); // 12 valid-UTF-8 repos × 11 safe-integer epochs
	});

	// ── fuzz ──
	const hex32 = fc
		.uint8Array({ minLength: 32, maxLength: 32 })
		.map((b) => bytesToHex(b));
	const carArb = fc.oneof(
		// CIDv1 sha256 with a few codecs, CIDv0, and an identity CID of odd length
		fc
			.tuple(fc.constantFrom(0x55, 0x71, 0x70), hex32)
			.map(([codec, d]) =>
				bytesToHex(
					concat([new Uint8Array([1, codec, 0x12, 0x20]), hexToBytes(d)]),
				),
			),
		hex32.map((d) => `0x1220${d.slice(2)}` as Hex),
		fc
			.uint8Array({ maxLength: 40 })
			.map((b) =>
				bytesToHex(concat([new Uint8Array([1, 0x55, 0, b.length]), b])),
			),
	);
	const epochArb = fc.oneof(
		fc.constantFrom(
			0,
			23,
			24,
			255,
			256,
			65535,
			65536,
			2 ** 32 - 1,
			2 ** 32,
			Number.MAX_SAFE_INTEGER,
		),
		fc.integer({ min: 0, max: 2 ** 32 + 10 }),
		fc.maxSafeNat(),
	);
	const repoArb = fc.oneof(
		fc.string({ unit: "binary", maxLength: 300 }),
		// raw UTF-16 code units: lone surrogates included
		fc.string({
			unit: fc
				.integer({ min: 0, max: 0xffff })
				.map((c) => String.fromCharCode(c)),
			maxLength: 40,
		}),
		fc.constantFrom(
			"a",
			"r".repeat(23),
			"r".repeat(24),
			"r".repeat(255),
			"r".repeat(256),
		),
	);
	const updateArb = fc.record({
		repo: repoArb,
		epoch: epochArb,
		parent: fc.oneof(fc.constant(ZERO_HEAD), hex32),
		diff: hex32,
		root: hex32,
		car: carArb,
	});

	it("fuzz: SDK commitHead = the Solidity port over the calldata bytes", async () => {
		await fc.assert(
			fc.asyncProperty(updateArb, async (u) => {
				expect(await commitHead(u)).toBe(
					refCommitHead(
						calldataBytes(u.repo),
						BigInt(u.epoch),
						u.parent,
						u.diff,
						u.root,
						hexToBytes(u.car),
					),
				);
			}),
			{ seed: 0xc0ffee, numRuns: runs },
		);
	});

	it("fuzz: a commit block decodes back to the update it was built from, and to its id's bytes", async () => {
		await fc.assert(
			fc.asyncProperty(
				updateArb.filter((u) => u.repo.isWellFormed()),
				async (u) => {
					const block = await encodeBlock({
						epoch: u.epoch,
						parent: u.parent === ZERO_HEAD ? null : cidFromDigest(u.parent),
						diff: cidFromDigest(u.diff),
						root: cidFromDigest(u.root),
						repo: u.repo,
						car: CID.decode(hexToBytes(u.car)),
					} satisfies CommitBlock);
					const back = decodeBlock<CommitBlock>(block.bytes);
					expect(commitUpdate(back)).toEqual(u);
					// the repo the commit names is the repo the registry keys it under
					expect(repoId(back.repo)).toBe(keccak256(calldataBytes(u.repo)));
				},
			),
			{ seed: 0xc0ffef, numRuns: runs },
		);
	});
});
