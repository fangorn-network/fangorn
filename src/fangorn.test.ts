import { describe, it, expect, vi, afterEach } from "vitest";
import type { Hex } from "viem";
import { Fangorn } from "./fangorn.js";
import { BaseSepoliaConfig, NetworkConfig } from "./config.js";

const WORKER = "https://worker.example/";
const KEY = ("0x" + "11".repeat(32)) as Hex;

afterEach(() => {
	vi.unstubAllGlobals();
});

/** Uploads one block through the signed-url worker; returns the worker request bodies. */
async function uploadThroughWorker(fangorn: Fangorn, worker = WORKER): Promise<Record<string, unknown>[]> {
	const sent: Record<string, unknown>[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn((url: string | URL, init?: RequestInit) => {
			// The upload POST carries FormData, so route before touching the body.
			if (String(url) !== worker) {
				return Promise.resolve(new Response(JSON.stringify({ data: { cid: "bafkrei" } })));
			}
			const body = JSON.parse(init?.body as string) as { signature?: string };
			sent.push(body);
			const res = body.signature
				? { ok: true, uploadUrl: "https://upload.example/put", network: "public" }
				: { challenge: "SIGN ME" };
			return Promise.resolve(new Response(JSON.stringify(res)));
		}),
	);
	await fangorn.getStorage().putFile(new Uint8Array([1]), "x");
	return sent;
}

describe("signed-url uploads", () => {
	it("send no app id", async () => {
		const fangorn = Fangorn.create({ privateKey: KEY, storage: { signedUrl: { workerUrl: WORKER } } });
		const sent = await uploadThroughWorker(fangorn);
		expect(sent).toHaveLength(2);
		expect(sent.every((b) => !("appId" in b))).toBe(true);
	});
});

describe("signed-url uploads → the network's hosted worker", () => {
	const create = (config: NetworkConfig, workerUrl?: string) =>
		Fangorn.create({ privateKey: KEY, config, storage: { signedUrl: { workerUrl } } });

	it("uses the network's own worker when none is given", async () => {
		expect(await uploadThroughWorker(create(BaseSepoliaConfig), BaseSepoliaConfig.signedUrlWorker)).toHaveLength(2);
	});

	it("refuses hosted uploads on a network with no worker, not falling back to another network's", () => {
		const noWorker = { ...BaseSepoliaConfig, signedUrlWorker: undefined };
		expect(() => create(noWorker)).toThrow(/no hosted upload worker/);
		expect(() => create(noWorker, WORKER)).not.toThrow();
	});

	it("treats a blank workerUrl (an unset CLI field) as unset", async () => {
		expect(await uploadThroughWorker(create(BaseSepoliaConfig, " "), BaseSepoliaConfig.signedUrlWorker)).toHaveLength(2);
	});

	it("defaults to Base Sepolia and its worker", async () => {
		const fangorn = Fangorn.create({ privateKey: KEY, storage: { signedUrl: {} } });
		expect(await uploadThroughWorker(fangorn, BaseSepoliaConfig.signedUrlWorker)).toHaveLength(2);
	});

	it("prefers an explicit workerUrl", async () => {
		expect(await uploadThroughWorker(create(BaseSepoliaConfig, WORKER))).toHaveLength(2);
	});
});
