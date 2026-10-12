import { describe, it, expect, vi, afterEach } from "vitest";
import type { Hex } from "viem";
import { Fangorn } from "./fangorn.js";
import { appId as toAppId, DEFAULT_APP } from "./config.js";

// Signed-url uploads bill an app's storage subscription, so every upload names
// the app the client is scoped to — the DEFAULT_APP fallback included, since
// nobody publishes outside an app.

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
	const create = (appId?: string) =>
		Fangorn.create({ privateKey: KEY, appId, storage: { signedUrl: { workerUrl: WORKER } } });

	it("sends the default app id when the caller never named an app", async () => {
		const fangorn = create();
		expect(fangorn.getAppId()).toBe(toAppId(DEFAULT_APP));
		expect(await uploadAndCaptureAppIds(fangorn)).toEqual([
			toAppId(DEFAULT_APP),
			toAppId(DEFAULT_APP),
		]);
	});

	it("treats a blank app id as no app, not as an app called \"\"", async () => {
		// An exported-but-empty FANGORN_APP_ID / `--app ""`. keccak("") is a
		// valid-looking id for an app nobody owns, so it must not reach either the
		// registries or the worker.
		const fangorn = create("  ");
		expect(fangorn.getAppId()).toBe(toAppId(DEFAULT_APP));
		expect(await uploadAndCaptureAppIds(fangorn)).toEqual([
			toAppId(DEFAULT_APP),
			toAppId(DEFAULT_APP),
		]);
	});

	it("sends the app id once one is named, including via setAppId", async () => {
		const fangorn = create("my-app");
		expect(await uploadAndCaptureAppIds(fangorn)).toEqual([
			toAppId("my-app"),
			toAppId("my-app"),
		]);

		fangorn.setAppId("other-app");
		expect(await uploadAndCaptureAppIds(fangorn)).toEqual([
			toAppId("other-app"),
			toAppId("other-app"),
		]);
	});
});
