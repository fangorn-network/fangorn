import { describe, it, expect, vi, afterEach } from "vitest";
import type { Hex } from "viem";
import { Fangorn } from "./fangorn.js";
import { appId as toAppId, ArbitrumSepoliaConfig, BaseSepoliaConfig } from "./config.js";

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
	it("need no app, and send none", async () => {
		const fangorn = Fangorn.create({ privateKey: KEY, storage: { signedUrl: { workerUrl: WORKER } } });
		const sent = await uploadThroughWorker(fangorn);
		expect(sent).toHaveLength(2);
		expect(sent.every((b) => !("appId" in b))).toBe(true);
	});

	it("treat a blank app id as no app, not as an app called \"\"", () => {
		const fangorn = Fangorn.create({ privateKey: KEY, appId: "  " });
		expect(fangorn.getAppId()).toBeUndefined();
	});
});

describe("signed-url uploads → the network's hosted worker", () => {
	const create = (config: typeof ArbitrumSepoliaConfig | typeof BaseSepoliaConfig, workerUrl?: string) =>
		Fangorn.create({ privateKey: KEY, config, storage: { signedUrl: { workerUrl } } });

	it("uses the network's own worker when none is given", async () => {
		expect(await uploadThroughWorker(create(BaseSepoliaConfig), BaseSepoliaConfig.signedUrlWorker)).toHaveLength(2);
	});

	it("refuses hosted uploads on a network with no worker, not falling back to another network's", () => {
		expect(() => create(ArbitrumSepoliaConfig)).toThrow(/no hosted upload worker/);
		expect(() => create(ArbitrumSepoliaConfig, WORKER)).not.toThrow();
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

// Renaming moves the app on chain to an alias of its canonical id; the client
// follows it only once the rename landed.
describe("Fangorn.renameApp", () => {
	const create = (appId?: string) => Fangorn.create({ privateKey: KEY, appId, config: BaseSepoliaConfig });

	it("renames the app on chain, then scopes the client to the new id", async () => {
		const fangorn = create("old-name");
		const rename = vi.spyOn(fangorn.getAppRegistry(), "renameApp").mockResolvedValue("0xhash");
		expect(await fangorn.renameApp(" new-name ")).toBe("0xhash");
		expect(rename).toHaveBeenCalledWith(toAppId("new-name"));
		expect(fangorn.getAppId()).toBe(toAppId("new-name"));
		expect(fangorn.getAppRegistry().getAppId()).toBe(toAppId("new-name"));
	});

	it("takes an app id as well as a name", async () => {
		const fangorn = create("old-name");
		const id = ("0x" + "cd".repeat(32)) as Hex;
		const rename = vi.spyOn(fangorn.getAppRegistry(), "renameApp").mockResolvedValue("0xhash");
		await fangorn.renameApp(id);
		expect(rename).toHaveBeenCalledWith(id);
		expect(fangorn.getAppId()).toBe(id);
	});

	it("keeps the old id when the rename fails, and refuses a blank name", async () => {
		const fangorn = create("old-name");
		const rename = vi.spyOn(fangorn.getAppRegistry(), "renameApp").mockRejectedValue(new Error("AppAlreadyRegistered"));
		await expect(fangorn.renameApp("taken")).rejects.toThrow(/AppAlreadyRegistered/);
		await expect(fangorn.renameApp("  ")).rejects.toThrow(/blank/);
		expect(rename).toHaveBeenCalledTimes(1);
		expect(fangorn.getAppId()).toBe(toAppId("old-name"));
	});
});
