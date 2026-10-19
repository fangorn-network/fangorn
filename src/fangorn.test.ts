import { describe, it, expect, vi, afterEach } from "vitest";
import type { Hex } from "viem";
import { Fangorn } from "./fangorn.js";
import { appId as toAppId } from "./config.js";

// Signed-url uploads name the app that sponsors them: the configured sponsor,
// else the client's app, else none (the worker's free tier).

const WORKER = "https://worker.example/";
const KEY = ("0x" + "11".repeat(32)) as Hex;

afterEach(() => {
	vi.unstubAllGlobals();
});

/** Uploads one block through the signed-url worker; returns the appIds it sent. */
async function uploadAndCaptureAppIds(fangorn: Fangorn): Promise<(Hex | undefined)[]> {
	const sent: (Hex | undefined)[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn((url: string | URL, init?: RequestInit) => {
			// The upload POST carries FormData, so route before touching the body.
			if (String(url) !== WORKER) {
				return Promise.resolve(new Response(JSON.stringify({ data: { cid: "bafkrei" } })));
			}
			const body = JSON.parse(init?.body as string) as { signature?: string; appId?: Hex };
			sent.push(body.appId);
			const res = body.signature
				? { ok: true, uploadUrl: "https://upload.example/put", network: "public" }
				: { challenge: "SIGN ME" };
			return Promise.resolve(new Response(JSON.stringify(res)));
		}),
	);
	await fangorn.getStorage().putFile(new Uint8Array([1]), "x");
	return sent;
}

describe("Fangorn app scope → signed-url uploads", () => {
	const create = (appId?: string, sponsor?: string) =>
		Fangorn.create({ privateKey: KEY, appId, storage: { signedUrl: { workerUrl: WORKER, sponsor } } });

	it("names no app when there is none: no default app", async () => {
		const fangorn = create();
		expect(fangorn.getAppId()).toBeUndefined();
		expect(await uploadAndCaptureAppIds(fangorn)).toEqual([undefined, undefined]);
	});

	it("treats a blank app id as no app, not as an app called \"\"", async () => {
		// An exported-but-empty FANGORN_APP_ID / `--app ""`. keccak("") is a
		// valid-looking id for an app nobody owns, so it must not reach the worker.
		const fangorn = create("  ");
		expect(fangorn.getAppId()).toBeUndefined();
		expect(await uploadAndCaptureAppIds(fangorn)).toEqual([undefined, undefined]);
	});

	it("sends the client's app once one is named, including via setAppId", async () => {
		const fangorn = create("my-app");
		expect(await uploadAndCaptureAppIds(fangorn)).toEqual([toAppId("my-app"), toAppId("my-app")]);

		fangorn.setAppId("other-app");
		expect(await uploadAndCaptureAppIds(fangorn)).toEqual([toAppId("other-app"), toAppId("other-app")]);
	});

	it("bills the sponsor over the client's app", async () => {
		const fangorn = create("reader-app", "my-storage");
		expect(await uploadAndCaptureAppIds(fangorn)).toEqual([toAppId("my-storage"), toAppId("my-storage")]);
	});
});
