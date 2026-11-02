import { describe, it, expect, vi, afterEach } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import type { Hex } from "viem";
import { SignedUrlBackend, DEFAULT_SIGNED_URL_WORKER } from "./signed-url.js";

const WORKER = "https://worker.example/";
const GATEWAY = "https://gw.example";

function jsonRes(obj: unknown, status = 200): Promise<Response> {
	return Promise.resolve(
		new Response(JSON.stringify(obj), {
			status,
			headers: { "content-type": "application/json" },
		}),
	);
}

function makeSigner() {
	return {
		address: "0x1111111111111111111111111111111111111111" as Hex,
		signMessage: vi.fn(() => Promise.resolve("0xdeadbeef" as Hex)),
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("SignedUrlBackend", () => {
	it("runs the ownership handshake, then uploads to the presigned URL", async () => {
		const signer = makeSigner();
		let grantBody: { message?: string; signature?: string } = {};
		let uploadedNetwork: FormDataEntryValue | null = null;
		let uploadedFile: FormDataEntryValue | null = null;

		const fetchMock = vi.fn((url: string | URL, init?: RequestInit) => {
			const target = String(url);
			if (target === WORKER) {
				const body = JSON.parse(init?.body as string) as {
					message?: string;
					signature?: string;
				};
				// First hit: no signature yet → hand back a challenge to sign.
				if (!body.signature) return jsonRes({ challenge: "SIGN ME" });
				// Second hit: signed challenge → issue the presigned URL.
				grantBody = body;
				return jsonRes({
					ok: true,
					uploadUrl: "https://upload.example/put",
					network: "public",
				});
			}
			if (target === "https://upload.example/put") {
				const fd = init?.body as FormData;
				uploadedNetwork = fd.get("network");
				uploadedFile = fd.get("file");
				return jsonRes({ data: { cid: "bafkreiuploaded" } });
			}
			throw new Error(`unexpected fetch: ${target}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const backend = new SignedUrlBackend(WORKER, signer, GATEWAY);
		const cid = await backend.putFile(new Uint8Array([1, 2, 3]), "data.car");

		expect(cid).toBe("bafkreiuploaded");
		expect(signer.signMessage).toHaveBeenCalledWith("SIGN ME");
		expect(grantBody.message).toBe("SIGN ME");
		expect(grantBody.signature).toBe("0xdeadbeef");
		expect(uploadedNetwork).toBe("public");
		expect(uploadedFile).toBeInstanceOf(File);
	});

	it("falls back to the hosted worker when no URL is given", async () => {
		const signer = makeSigner();
		const hosts = new Set<string>();
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string | URL, init?: RequestInit) => {
				const target = String(url);
				hosts.add(new URL(target).origin);
				const body = JSON.parse(init?.body as string) as { signature?: string };
				if (!body.signature) return jsonRes({ challenge: "SIGN ME" });
				return jsonRes({ ok: true, uploadUrl: `${target}put`, network: "public" });
			}),
		);
		// Empty string (an unset CLI field) must also use the default.
		const backend = new SignedUrlBackend("", signer, GATEWAY);
		// The upload URL echoes back the worker, so a rejected upload still proves
		// which worker was hit.
		await backend.putFile(new Uint8Array([1]), "x").catch(() => undefined);
		expect(hosts).toContain(new URL(DEFAULT_SIGNED_URL_WORKER).origin);
	});

	it("surfaces the worker's error AND detail instead of a bogus URL", async () => {
		const signer = makeSigner();
		vi.stubGlobal(
			"fetch",
			vi.fn((_url: string | URL, init?: RequestInit) => {
				const body = JSON.parse(init?.body as string) as { signature?: string };
				if (!body.signature) return jsonRes({ challenge: "SIGN ME" });
				// Shape of the worker's 502 when it can't mint the Pinata URL.
				return jsonRes(
					{
						error: "Failed to create Pinata upload URL.",
						detail: "Pinata HTTP 401: invalid JWT",
					},
					502,
				);
			}),
		);
		const backend = new SignedUrlBackend(WORKER, signer, GATEWAY);
		// The detail is the actionable half — it must reach the caller.
		await expect(backend.putFile(new Uint8Array([1]), "x")).rejects.toThrow(
			/Failed to create Pinata upload URL\..*invalid JWT/,
		);
	});

	it("translates a dag-cbor commit CID to its raw sibling for gateway reads", async () => {
		const signer = makeSigner();
		const bytes = new Uint8Array([9, 8, 7]);
		const digest = await sha256.digest(bytes);
		const dagCbor = CID.createV1(0x71, digest); // bafyrei… (commit block)
		const raw = CID.createV1(0x55, digest); // bafkrei… (how putBlock pinned it)

		let fetched = "";
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string | URL) => {
				fetched = String(url);
				return Promise.resolve(new Response(bytes.buffer, { status: 200 }));
			}),
		);

		const backend = new SignedUrlBackend(WORKER, signer, GATEWAY);
		const out = await backend.getRawBlock(dagCbor.toString());

		expect(fetched).toBe(`${GATEWAY}/ipfs/${raw.toString()}`);
		expect(out).toEqual(bytes);
	});
});
