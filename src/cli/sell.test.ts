import { afterEach, describe, it, expect, vi } from "vitest";
import { x25519 } from "@noble/curves/ed25519";
import { createWalletClient, custom, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { repoId } from "../contracts/data-registry/index.js";
import {
	SettlementRegistryClient,
	recordKey,
} from "../contracts/settlement-registry/index.js";
import {
	decryptField,
	deriveRecordKey,
	makeDeposit,
	newRepoKey,
	statement,
	type AccessRequest,
	type FieldHandle,
	type PaidScope,
} from "../crypto/paid.js";
import { MemStorage } from "../engine/test-helpers.js";
import type { Fangorn } from "../fangorn.js";
import { testKeyServer } from "../test/key-server.js";
import { sealRecords } from "./sell.js";

const REGISTRY = "0x00000000000000000000000000000000000000aa" as const;
const KS = "https://keys.test";
const ksSecret = x25519.utils.randomSecretKey();
const account = privateKeyToAccount(generatePrivateKey());
const scope: PaidScope = {
	chainId: baseSepolia.id,
	registry: REGISTRY,
	publisher: account.address,
	repo: repoId("shop"),
	generation: 0n,
};

/** Just enough Fangorn for sealRecords, with `existing` as the repo's `@deposit/0`. */
function fangorn(existing: Record<string, unknown> | null) {
	const publicClient = {
		getChainId: () => Promise.resolve(baseSepolia.id),
		readContract: () => Promise.resolve(0n),
	} as unknown as PublicClient;
	const wallet = createWalletClient({
		account,
		chain: baseSepolia,
		transport: custom({ request: () => Promise.reject(new Error("no rpc")) }),
	});
	const storage = new MemStorage();
	return {
		storage,
		f: {
			getSettlementRegistry: () =>
				new SettlementRegistryClient(REGISTRY, publicClient, wallet),
			getAddress: () => account.address,
			getConfig: () => ({ chain: baseSepolia, keyServer: KS }),
			getWalletClient: () => wallet,
			getStorage: () => storage,
			engine: {
				readRecord: () =>
					Promise.resolve(
						existing && {
							id: "@deposit/0",
							cid: "x",
							type: "deposit",
							payload: existing,
						},
					),
			},
		} as unknown as Fangorn,
	};
}

afterEach(() => vi.unstubAllGlobals());

/** sealRecords over a repo that already has `@deposit/0`, sealing record `a`'s body. */
async function sealWithExistingDeposit() {
	const kRepo = newRepoKey();
	const deposit = makeDeposit({
		kRepo,
		keyServerPubkey: x25519.getPublicKey(ksSecret),
		keyServer: KS,
		scope,
	});
	vi.stubGlobal("fetch", (_url: string, init: RequestInit) =>
		testKeyServer(JSON.parse(init.body as string) as AccessRequest, {
			secret: ksSecret,
			chainId: scope.chainId,
			registry: REGISTRY,
			canRead: () => Promise.resolve(false),
		}),
	);
	const { f, storage } = fangorn(deposit as unknown as Record<string, unknown>);
	const out = await sealRecords(
		f,
		"shop",
		[{ id: "a", type: "note", payload: { title: "t", body: "secret" } }],
		{ fields: ["body"], price: 1n, shareBps: 0, deadline: 9n },
	);
	return { kRepo, deposit, out, storage };
}

describe("sealRecords", () => {
	it("seals under the existing deposit's repo key, fetched from its key server", async () => {
		const { kRepo, out, storage } = await sealWithExistingDeposit();
		const handle = out.find((r) => r.id === "a")?.payload.body as FieldHandle;
		const stmt = statement(scope);
		const key = recordKey("a");
		const ct = await storage.getFile(handle.cid);
		expect(
			new TextDecoder().decode(
				decryptField(deriveRecordKey(kRepo, stmt, key), ct, stmt, key, "body"),
			),
		).toBe(JSON.stringify("secret"));
	});

	// Regression: `fangorn commit --paid --replace` starts from an empty state, so a deposit
	// sealRecords didn't re-emit was dropped and every record sealed under it stopped opening.
	it("re-emits an existing deposit, so a --replace commit doesn't drop it", async () => {
		const { deposit, out } = await sealWithExistingDeposit();
		expect(out.find((r) => r.id === "@deposit/0")?.payload).toEqual(deposit);
	});
});
