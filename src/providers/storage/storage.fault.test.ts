/* eslint-disable vitest/no-conditional-expect -- each generated fault decides the expected outcome */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { CID } from "multiformats/cid";
import * as dagCbor from "@ipld/dag-cbor";
import { encode } from "multiformats/block";
import { sha256 } from "multiformats/hashes/sha2";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { SignedUrlBackend } from "./signed-url.js";
import { PinataBackend } from "./pinata.js";
import { MAX_UPLOAD_ATTEMPTS } from "./utils.js";
import type { MetadataStorage, RawBlock } from "./types.js";
import { memoryNetwork, MemRegistry } from "../../test/testbed.js";
import { Fangorn } from "../../fangorn.js";
import { FangornConfig } from "../../config.js";

// Fault injection on storage: 5xx / 429 / timeouts / malformed bodies / wrong
// CIDs on upload, and wrong bytes on read. Errors must surface (after bounded
// retries for transient ones) and no corrupted data may be accepted.

const RUNS = Number(process.env.FUZZ_RUNS ?? 100);
const SEED = 0x570e;

const WORKER = "https://worker.example/";
const UPLOAD = "https://upload.example/put";
const GATEWAY = "https://gw.example";

const signer = {
	address: "0x1111111111111111111111111111111111111111" as Hex,
	signMessage: () => Promise.resolve("0xdeadbeef" as Hex),
};

const json = (obj: unknown, status = 200) =>
	Promise.resolve(new Response(JSON.stringify(obj), { status }));

async function block(n: number): Promise<RawBlock> {
	const b = await encode({ value: { n }, codec: dagCbor, hasher: sha256 });
	return { cid: b.cid, bytes: b.bytes };
}
const rawSibling = (b: RawBlock) => CID.createV1(0x55, b.cid.multihash);

// One upload attempt's outcome. Transient ones are retried by withUploadRetry.
const ATTEMPT = [
	"ok",
	"worker5xxNoBody",
	"worker503Json",
	"worker429Json",
	"timeout",
	"upload500",
	"upload429",
	"workerMalformed200",
	"workerDenied403",
	"uploadNoCid",
	"uploadWrongCid",
] as const;
type Attempt = (typeof ATTEMPT)[number];
const TRANSIENT: Attempt[] = [
	"worker5xxNoBody",
	"worker503Json",
	"worker429Json",
	"timeout",
	"upload500",
	"upload429",
];

/** fetch, scripted: upload attempt i behaves as `script[i]` (then "ok"). An attempt starts at its challenge request. */
function scriptedFetch(script: Attempt[], good: RawBlock, wrong: RawBlock) {
	let started = 0;
	let a: Attempt = "ok";
	return {
		attempts: () => started,
		fetch: (url: string | URL, init?: RequestInit) => {
			const target = String(url);
			if (target === WORKER) {
				const body = JSON.parse(init?.body as string) as { signature?: string };
				if (!body.signature) a = script[started++] ?? "ok";
				if (a === "timeout")
					return Promise.reject(
						new DOMException(
							"The operation was aborted due to timeout",
							"TimeoutError",
						),
					);
				if (a === "worker5xxNoBody")
					return Promise.resolve(new Response("", { status: 502 }));
				if (a === "worker503Json") return json({ error: "overloaded" }, 503);
				if (a === "worker429Json") return json({ error: "slow down" }, 429);
				if (a === "workerMalformed200")
					return Promise.resolve(new Response("{not json", { status: 200 }));
				if (!body.signature) return json({ challenge: "SIGN ME" });
				if (a === "workerDenied403")
					return json({ error: "storage quota exceeded" }, 403);
				return json({ ok: true, uploadUrl: UPLOAD, network: "public" });
			}
			if (target === UPLOAD) {
				if (a === "upload500") return json({ error: "boom" }, 500);
				if (a === "upload429") return json({ error: "rate" }, 429);
				if (a === "uploadNoCid") return json({ data: {} });
				if (a === "uploadWrongCid")
					return json({ data: { cid: rawSibling(wrong).toString() } });
				return json({ data: { cid: rawSibling(good).toString() } });
			}
			return Promise.reject(new Error(`unexpected fetch ${target}`));
		},
	};
}

/** Run `p` to completion under fake timers (retry backoffs are real sleeps). */
async function settle<T>(
	p: Promise<T>,
): Promise<{ ok: true; v: T } | { ok: false; e: Error }> {
	const out = p.then(
		(v) => ({ ok: true as const, v }),
		(e: unknown) => ({ ok: false as const, e: e as Error }),
	);
	await vi.runAllTimersAsync();
	return out;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("SignedUrlBackend uploads under injected faults", () => {
	it("succeeds iff an attempt succeeds before a permanent fault or the retry cap", async () => {
		const good = await block(1);
		const wrong = await block(2);
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.constantFrom(...ATTEMPT), {
					maxLength: MAX_UPLOAD_ATTEMPTS + 2,
				}),
				async (script) => {
					const f = scriptedFetch(script, good, wrong);
					vi.stubGlobal("fetch", f.fetch);
					const backend = new SignedUrlBackend(WORKER, signer, GATEWAY);
					const res = await settle(backend.putBlock(good));

					const padded = [
						...script,
						...Array<Attempt>(MAX_UPLOAD_ATTEMPTS).fill("ok"),
					];
					const first = padded.findIndex((a) => !TRANSIENT.includes(a));
					const expectOk =
						padded[first] === "ok" && first < MAX_UPLOAD_ATTEMPTS;
					expect(res.ok).toBe(expectOk);
					// bounded: never more attempts than the cap, none after a permanent fault
					expect(f.attempts()).toBe(Math.min(first + 1, MAX_UPLOAD_ATTEMPTS));
					if (!res.ok) expect(res.e.message.length).toBeGreaterThan(0);
				},
			),
			{ seed: SEED, numRuns: RUNS },
		);
	});

	it("a wrong CID back from the upload fails the upload, not every later read", async () => {
		const good = await block(1);
		const wrong = await block(2);
		const f = scriptedFetch(["uploadWrongCid"], good, wrong);
		vi.stubGlobal("fetch", f.fetch);
		const res = await settle(
			new SignedUrlBackend(WORKER, signer, GATEWAY).putBlock(good),
		);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.e.message).toMatch(/readers could not fetch it/);
	});

	it("putFile rejects a raw CID whose digest is not the bytes'", async () => {
		const good = await block(1);
		const wrong = await block(2);
		const f = scriptedFetch(["uploadWrongCid"], good, wrong);
		vi.stubGlobal("fetch", f.fetch);
		const res = await settle(
			new SignedUrlBackend(WORKER, signer, GATEWAY).putFile(
				good.bytes,
				"x.car",
			),
		);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.e.message).toMatch(/sha256 does not match/);
	});

	it("a 429 with a JSON body from the worker is retried, not fatal", async () => {
		const good = await block(1);
		const f = scriptedFetch([], good, good);
		let first = true;
		vi.stubGlobal("fetch", (url: string | URL, init?: RequestInit) => {
			if (String(url) === WORKER && first) {
				first = false;
				return json({ error: "slow down" }, 429);
			}
			return f.fetch(url, init);
		});
		const res = await settle(
			new SignedUrlBackend(WORKER, signer, GATEWAY).putBlock(good),
		);
		expect(res.ok).toBe(true);
	});
});

describe("PinataBackend uploads under injected faults", () => {
	function withFakeSdk(cidFor: (bytes: Uint8Array) => Promise<string>) {
		const backend = new PinataBackend("jwt", GATEWAY);
		(backend as unknown as { pinata: unknown }).pinata = {
			upload: {
				public: {
					file: async (file: File) => ({
						cid: await cidFor(new Uint8Array(await file.arrayBuffer())),
						id: "x",
					}),
				},
			},
		};
		return backend;
	}

	it("putBlock accepts exactly the block's raw sibling CID", async () => {
		const good = await block(1);
		const wrong = await block(2);
		await fc.assert(
			fc.asyncProperty(
				fc.constantFrom("right", "otherBlock", "dagCborCodec", "garbage"),
				async (kind) => {
					const backend = withFakeSdk(() =>
						Promise.resolve(
							kind === "right"
								? rawSibling(good).toString()
								: kind === "otherBlock"
									? rawSibling(wrong).toString()
									: kind === "dagCborCodec"
										? good.cid.toString()
										: "not-a-cid",
						),
					);
					const res = await settle(backend.putBlock(good));
					expect(res.ok).toBe(kind === "right");
				},
			),
			{ seed: SEED, numRuns: 20 },
		);
	});

	it("putFile checks a raw CID's digest, and leaves a chunked (dag-pb) one to read-time checks", async () => {
		const bytes = new Uint8Array([1, 2, 3]);
		const raw = CID.createV1(0x55, await sha256.digest(bytes)).toString();
		const otherRaw = CID.createV1(
			0x55,
			await sha256.digest(new Uint8Array([9])),
		).toString();
		const dagPb = CID.createV1(0x70, await sha256.digest(bytes)).toString();
		for (const [cid, ok] of [
			[raw, true],
			[otherRaw, false],
			[dagPb, true],
		] as const) {
			const res = await settle(
				withFakeSdk(() => Promise.resolve(cid)).putFile(bytes, "c.car"),
			);
			expect(res.ok).toBe(ok);
		}
	});
});

describe("gateway reads under injected faults", () => {
	const GATEWAY_FAULTS = [
		"ok",
		"http500",
		"http429",
		"http404",
		"timeout",
		"networkError",
	] as const;

	it("retries a bounded number of times, then surfaces the error", async () => {
		const good = await block(1);
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.constantFrom(...GATEWAY_FAULTS), { maxLength: 7 }),
				async (script) => {
					let i = 0;
					vi.stubGlobal("fetch", () => {
						const a = script[i++] ?? "ok";
						if (a === "ok") return Promise.resolve(new Response(good.bytes));
						if (a === "timeout")
							return Promise.reject(new DOMException("aborted", "AbortError"));
						if (a === "networkError")
							return Promise.reject(new TypeError("fetch failed"));
						return Promise.resolve(
							new Response("", { status: Number(a.slice(4)) }),
						);
					});
					const res = await settle(
						new SignedUrlBackend(WORKER, signer, GATEWAY).getRawBlock(
							good.cid.toString(),
						),
					);
					const firstOk = [...script, "ok"].indexOf("ok");
					expect(res.ok).toBe(firstOk < 5);
					if (res.ok) expect(res.v).toEqual(good.bytes);
					expect(i).toBe(Math.min(firstOk + 1, 5));
				},
			),
			{ seed: SEED, numRuns: RUNS },
		);
	});
});

describe("reads through a lying storage backend", () => {
	/** Storage that corrupts what it hands back, per `how`. */
	function lying(
		inner: MetadataStorage,
		how: string,
		target: "block" | "file",
	): MetadataStorage {
		const corrupt = (b: Uint8Array): Uint8Array => {
			if (how === "flip") {
				// a copy: the stored bytes may be a Buffer, whose slice() is a view
				const c = new Uint8Array(b);
				c[c.length >> 1] ^= 0xff;
				return c;
			}
			if (how === "truncate") return b.slice(0, b.length >> 1);
			if (how === "empty") return new Uint8Array();
			return new Uint8Array([...b, 0]); // append
		};
		return {
			...inner,
			getRawBlock: async (u) => {
				const b = await inner.getRawBlock(u);
				return target === "block" ? corrupt(b) : b;
			},
			getFile: async (u) => {
				const b = await inner.getFile(u);
				return target === "file" ? corrupt(b) : b;
			},
		};
	}

	it("never accepts corrupted bytes as repo contents", async () => {
		vi.useRealTimers();
		const net = memoryNetwork();
		const pub = await net.client();
		await pub.initRepo("r");
		await pub.uploadBatch("r", [
			{ id: "a", type: "t", payload: { v: 1 } },
			{ id: "b", type: "t", payload: { v: 2 } },
		]);
		const truth = (await pub.readRepo(pub.getAddress(), "r")).contents.records
			.map((r) => [r.id, r.payload])
			.sort();

		await fc.assert(
			fc.asyncProperty(
				fc.constantFrom("flip", "truncate", "empty", "append"),
				fc.constantFrom("block" as const, "file" as const),
				async (how, target) => {
					const sk = generatePrivateKey();
					const reader = Fangorn.create({
						privateKey: sk,
						config: { ...FangornConfig, fromBlock: 0n },
						storage: { backend: lying(net.storage, how, target) },
						registry: new MemRegistry(
							privateKeyToAccount(sk).address,
							net.ledger,
						),
					});
					const res = await reader.readRepo(pub.getAddress(), "r").then(
						(r) => r.contents.records.map((x) => [x.id, x.payload]).sort(),
						() => null,
					);
					// Either it refuses, or it returns the truth: never something else.
					// (Truncating/appending a CAR file can leave every block intact.)
					if (res !== null) expect(res).toEqual(truth);
					if (target === "block") expect(res).toBeNull();
				},
			),
			{ seed: SEED, numRuns: 16 },
		);
	});
});
