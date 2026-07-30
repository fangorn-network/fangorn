import { describe, it, expect, vi, afterEach } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import {
	serialize,
	deserialize,
	isTransientUpload,
	withUploadRetry,
	MAX_UPLOAD_ATTEMPTS,
	fetchRawByCid,
	retrieveByCid,
} from "./utils.js";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("serialize / deserialize", () => {
	it("passes strings through serialize untouched", () => {
		expect(serialize("hello")).toBe("hello");
	});

	it("round-trips plain JSON structures", () => {
		const value = { a: 1, b: ["x", true, null], c: { nested: "y" } };
		expect(deserialize(serialize(value))).toEqual(value);
	});

	it("encodes a Uint8Array to a tagged base64 envelope", () => {
		const out = JSON.parse(serialize(new Uint8Array([1, 2, 3]))) as {
			__type: string;
			data: string;
		};
		expect(out.__type).toBe("Uint8Array");
		expect(out.data).toBe(Buffer.from([1, 2, 3]).toString("base64"));
	});

	it("revives a tagged envelope back into a Uint8Array", () => {
		const bytes = new Uint8Array([9, 8, 7, 0, 255]);
		const revived = deserialize(serialize(bytes));
		expect(revived).toBeInstanceOf(Uint8Array);
		expect(revived).toEqual(bytes);
	});

	it("revives Uint8Arrays nested inside objects and arrays", () => {
		const value = {
			key: new Uint8Array([1, 2]),
			list: [new Uint8Array([3]), "plain"],
		};
		const revived = deserialize(serialize(value)) as typeof value;
		expect(revived.key).toEqual(new Uint8Array([1, 2]));
		expect(revived.list[0]).toEqual(new Uint8Array([3]));
		expect(revived.list[1]).toBe("plain");
	});

	it("leaves objects that merely resemble the envelope alone", () => {
		// Missing the "data" field → not a Uint8Array envelope.
		const value = { __type: "Uint8Array" };
		expect(deserialize(serialize(value))).toEqual(value);
	});
});

describe("isTransientUpload", () => {
	it.each([408, 425, 429, 500, 502, 503])(
		"treats status %i as transient",
		(statusCode) => {
			expect(isTransientUpload({ statusCode })).toBe(true);
		},
	);

	it.each([400, 401, 403, 404])(
		"treats client status %i as non-transient",
		(statusCode) => {
			expect(isTransientUpload({ statusCode })).toBe(false);
		},
	);

	it.each([
		"socket hang up",
		"fetch failed",
		"ECONNRESET happened",
		"ETIMEDOUT",
		"the request timed out",
		"connection terminated",
		"network error",
	])("matches transient message %j", (message) => {
		expect(isTransientUpload({ message })).toBe(true);
	});

	it("matches a transient error code", () => {
		expect(isTransientUpload({ code: "EAI_AGAIN" })).toBe(true);
	});

	it("returns false for an ordinary error", () => {
		expect(isTransientUpload(new Error("bad request: invalid payload"))).toBe(
			false,
		);
	});

	it("tolerates a bare/empty error object", () => {
		expect(isTransientUpload({})).toBe(false);
	});
});

describe("withUploadRetry", () => {
	it("returns the value when the operation succeeds first try", async () => {
		const fn = vi.fn(() => Promise.resolve("ok"));
		await expect(withUploadRetry("label", fn)).resolves.toBe("ok");
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("rethrows a non-transient error without retrying", async () => {
		const fn = vi.fn(() => Promise.reject(new Error("HTTP 401 bad auth")));
		await expect(withUploadRetry("label", fn)).rejects.toThrow("HTTP 401");
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("retries transient failures with backoff, then succeeds", async () => {
		vi.useFakeTimers();
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const fn = vi
			.fn()
			.mockRejectedValueOnce({ statusCode: 503 })
			.mockRejectedValueOnce({ statusCode: 429 })
			.mockResolvedValueOnce("done");

		const promise = withUploadRetry("chunk", fn);
		await vi.runAllTimersAsync();

		await expect(promise).resolves.toBe("done");
		expect(fn).toHaveBeenCalledTimes(3);
	});

	it("gives up after MAX_UPLOAD_ATTEMPTS on persistent transient errors", async () => {
		vi.useFakeTimers();
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const err = Object.assign(new Error("service unavailable"), {
			statusCode: 500,
		});
		const fn = vi.fn().mockRejectedValue(err);

		const promise = withUploadRetry("chunk", fn);
		// The promise ultimately rejects; attach a catch so the rejection is handled
		// before we drive the fake clock.
		const settled = promise.catch((e: unknown) => e);
		await vi.runAllTimersAsync();

		await settled;
		await expect(promise).rejects.toBe(err);
		expect(fn).toHaveBeenCalledTimes(MAX_UPLOAD_ATTEMPTS);
	});
});

describe("fetchRawByCid", () => {
	it("fetches raw bytes from the default gateway", async () => {
		const bytes = new Uint8Array([4, 5, 6]);
		let fetched = "";
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string | URL) => {
				fetched = String(url);
				return Promise.resolve(new Response(bytes.buffer, { status: 200 }));
			}),
		);

		const out = await fetchRawByCid("bafkreisomecid");
		expect(out).toEqual(bytes);
		expect(fetched).toBe("https://ipfs.io/ipfs/bafkreisomecid");
	});

	it("translates a dag-cbor CID to its raw (0x55) sibling before fetching", async () => {
		const bytes = new Uint8Array([1, 1, 2, 3]);
		const digest = await sha256.digest(bytes);
		const dagCbor = CID.createV1(0x71, digest); // bafyrei…
		const raw = CID.createV1(0x55, digest); // bafkrei…

		let fetched = "";
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string | URL) => {
				fetched = String(url);
				return Promise.resolve(new Response(bytes.buffer, { status: 200 }));
			}),
		);

		await fetchRawByCid(dagCbor.toString(), "https://gw.example");
		expect(fetched).toBe(`https://gw.example/ipfs/${raw.toString()}`);
	});

	it("prefixes a bare gateway host with https and strips the ipfs:// scheme", async () => {
		let fetched = "";
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string | URL) => {
				fetched = String(url);
				return Promise.resolve(
					new Response(new Uint8Array().buffer, { status: 200 }),
				);
			}),
		);

		await fetchRawByCid("ipfs://bafkreibare", "my.gateway.cloud");
		expect(fetched).toBe("https://my.gateway.cloud/ipfs/bafkreibare");
	});

	it("throws after exhausting retries on a non-ok response", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve(new Response("nope", { status: 500 }))),
		);

		await expect(
			fetchRawByCid("bafkreimissing", "https://gw.example", {
				retries: 1,
			}),
		).rejects.toThrow(/after 1 attempts/);
	});
});

describe("retrieveByCid", () => {
	it("fetches and deserializes JSON content", async () => {
		const payload = { hello: "world", bytes: new Uint8Array([1, 2]) };
		vi.stubGlobal(
			"fetch",
			vi.fn(() =>
				Promise.resolve(new Response(serialize(payload), { status: 200 })),
			),
		);

		const out = await retrieveByCid<typeof payload>("bafyfoo");
		expect(out.hello).toBe("world");
		expect(out.bytes).toEqual(new Uint8Array([1, 2]));
	});

	it("builds the URL from a bare gateway host and ipfs:// path", async () => {
		let fetched = "";
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string | URL) => {
				fetched = String(url);
				return Promise.resolve(new Response("{}", { status: 200 }));
			}),
		);

		await retrieveByCid("ipfs://bafybar", "gw.example");
		expect(fetched).toBe("https://gw.example/ipfs/bafybar");
	});

	it("throws on a non-ok response", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() =>
				Promise.resolve(
					new Response("x", { status: 404, statusText: "Not Found" }),
				),
			),
		);

		await expect(retrieveByCid("bafymissing")).rejects.toThrow(
			/Failed to retrieve bafymissing/,
		);
	});

	it("reports a timeout when the fetch aborts", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn((_url: string | URL, init?: RequestInit) => {
				return new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						const err = new Error("aborted");
						err.name = "AbortError";
						reject(err);
					});
				});
			}),
		);

		await expect(
			retrieveByCid("bafyslow", "https://gw.example", 5),
		).rejects.toThrow(/Timed out retrieving bafyslow/);
	});
});
