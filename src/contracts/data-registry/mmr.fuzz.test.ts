import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { readFileSync } from "fs";
import {
	encodeAbiParameters,
	hexToString,
	keccak256,
	toHex,
	type Address,
	type Hex,
} from "viem";
import { EMPTY_MMR, logLeaf, mmrAppend, mmrRoot, type Mmr } from "./mmr.js";
import { repoId, type UpdateEntry } from "./index.js";

// The client MMR (mmr.ts) against DataRegistry's `_append` / `logRoot`: a port of the Solidity
// written here, fuzzed; and the contract's own roots (forge, mmr.vectors.json).
// FUZZ_RUNS=<n> for a longer campaign.

const runs = Number(process.env.FUZZ_RUNS ?? 200);

// ── Reference: DataRegistry's storage and functions ──────────────────────────

// `bytes32 constant LEAF = "leaf"`: a string literal, left-aligned and zero-padded
const tag = (s: string): Hex =>
	`0x${Buffer.from(s).toString("hex").padEnd(64, "0")}`;
const LEAF = tag("leaf"),
	NODE = tag("node"),
	MMR = tag("mmr");
const ZERO: Hex = `0x${"0".repeat(64)}`;

class SolLog {
	logLength = 0n;
	peaks = new Map<bigint, Hex>(); // mapping(uint256 => bytes32), stale slots kept

	/** `_log`'s leaf: keccak256(abi.encode(LEAF, publisher, repo_id, pos, head, timestamp)) */
	static leaf(
		publisher: Address,
		repoIdHash: Hex,
		pos: bigint,
		head: Hex,
		ts: bigint,
	): Hex {
		return keccak256(
			encodeAbiParameters(
				[
					{ type: "bytes32" },
					{ type: "address" },
					{ type: "bytes32" },
					{ type: "uint64" },
					{ type: "bytes32" },
					{ type: "uint64" },
				],
				[LEAF, publisher, repoIdHash, pos, head, ts],
			),
		);
	}

	append(leaf: Hex) {
		const n = this.logLength;
		let node = leaf;
		let height = 0n;
		while (((n >> height) & 1n) === 1n) {
			node = keccak256(
				encodeAbiParameters(
					[{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
					[NODE, this.peaks.get(height) ?? ZERO, node],
				),
			);
			height++;
		}
		this.peaks.set(height, node);
		this.logLength = n + 1n;
	}

	logRoot(): Hex {
		const n = this.logLength;
		const live: Hex[] = [];
		for (let height = 64n; height > 0n; height--)
			if (((n >> (height - 1n)) & 1n) === 1n)
				live.push(this.peaks.get(height - 1n) ?? ZERO);
		return keccak256(
			encodeAbiParameters(
				[{ type: "bytes32" }, { type: "uint64" }, { type: "bytes32[]" }],
				[MMR, n, live],
			),
		);
	}
}

const hex = (n: number) =>
	fc.uint8Array({ minLength: n, maxLength: n }).map((b) => toHex(b));
const entryArb = fc.record({
	publisher: hex(20),
	repo: fc.string({ unit: "binary", maxLength: 40 }),
	pos: fc.integer({ min: 1, max: 2 ** 31 }),
	head: hex(32),
	timestamp: fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }),
});
const toEntry = (e: Omit<UpdateEntry, "parent" | "t" | "id">): UpdateEntry => ({
	...e,
	parent: ZERO,
	t: 0n,
	id: "",
});

describe("client MMR vs DataRegistry", () => {
	it("empty log root matches", () => {
		expect(mmrRoot(EMPTY_MMR)).toBe(new SolLog().logRoot());
	});

	it("fuzz: logLeaf, mmrAppend and mmrRoot track the contract after every append", () => {
		fc.assert(
			fc.property(fc.array(entryArb, { maxLength: 70 }), (entries) => {
				const sol = new SolLog();
				let mmr: Mmr = EMPTY_MMR;
				for (const raw of entries) {
					const e = toEntry(raw);
					const leaf = logLeaf(e);
					expect(leaf).toBe(
						SolLog.leaf(
							e.publisher,
							keccak256(toHex(e.repo)),
							BigInt(e.pos),
							e.head,
							e.timestamp,
						),
					);
					sol.append(leaf);
					mmr = mmrAppend(mmr, leaf);
					expect(mmr.n).toBe(Number(sol.logLength));
					// live peaks agree
					const live = (get: (h: number) => Hex | null | undefined) =>
						mmr.peaks.map((_, h) => ((mmr.n >> h) & 1 ? get(h) : null));
					expect(live((h) => mmr.peaks[h])).toEqual(
						live((h) => sol.peaks.get(BigInt(h))),
					);
					expect(mmrRoot(mmr)).toBe(sol.logRoot());
				}
			}),
			{ seed: 0x3337, numRuns: runs },
		);
	});

	it("fuzz: long logs (n up to 2^11) agree at every power-of-two boundary", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 2 ** 11 + 3 }),
				hex(32),
				(n, seed) => {
					const sol = new SolLog();
					let mmr: Mmr = EMPTY_MMR;
					for (let i = 0; i < n; i++) {
						const leaf = keccak256(
							`${seed}${i.toString(16).padStart(8, "0")}` as Hex,
						);
						sol.append(leaf);
						mmr = mmrAppend(mmr, leaf);
					}
					expect(mmrRoot(mmr)).toBe(sol.logRoot());
				},
			),
			{ seed: 0x3338, numRuns: Math.min(runs, 20) },
		);
	}, 120_000); // ~1s locally, >10s on CI under coverage
});

// ── The contract's own roots ─────────────────────────────────────────────────

const VECTORS = JSON.parse(
	readFileSync(new URL("./mmr.vectors.json", import.meta.url), "utf8"),
) as {
	emptyRoot: Hex;
	entries: {
		publisher: Address;
		repo: Hex;
		head: Hex;
		timestamp: number;
		logRoot: Hex;
	}[];
};

/** Replay forge's log, the repo id from the event's topic or re-hashed from the decoded name. */
function replay(withEventRepoId: boolean) {
	const pos = new Map<string, number>();
	let mmr: Mmr = EMPTY_MMR;
	return VECTORS.entries.map((v) => {
		const k = `${v.publisher}/${v.repo}`;
		const p = (pos.get(k) ?? 0) + 1;
		pos.set(k, p);
		const e = {
			publisher: v.publisher,
			// what viem's event decoder makes of the `string repo` field
			repo: hexToString(v.repo),
			pos: p,
			parent: ZERO,
			head: v.head,
			t: 0n,
			timestamp: BigInt(v.timestamp),
			id: "",
			...(withEventRepoId ? { repoId: keccak256(v.repo) } : {}),
		};
		mmr = mmrAppend(mmr, logLeaf(e));
		return mmrRoot(mmr) === v.logRoot;
	});
}

describe("client MMR vs forge-run DataRegistry", () => {
	it("empty root", () => {
		expect(mmrRoot(EMPTY_MMR)).toBe(VECTORS.emptyRoot);
	});

	it("with the event's repo_id, every root matches, invalid-UTF-8 repo names included", () => {
		expect(replay(true).every(Boolean)).toBe(true);
	});

	it("FINDING: re-hashing the decoded repo string diverges forever at the first non-UTF-8 name", () => {
		const ok = replay(false);
		const firstBad = ok.indexOf(false);
		const bad = VECTORS.entries[firstBad];
		expect(firstBad).toBeGreaterThan(0); // valid names before it matched
		expect(bad.repo).toBe("0x61ff"); // "a\xff": not UTF-8
		expect(repoId(hexToString(bad.repo))).not.toBe(keccak256(bad.repo));
		expect(ok.slice(firstBad).some(Boolean)).toBe(false); // and never recovers
	});
});
