import { describe, it, expect } from "vitest";
import { x25519 } from "@noble/curves/ed25519";
import { bytesToHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { MemStorage } from "../engine/test-helpers.js";
import { WHOLE_REPO, recordKey } from "../contracts/settlement-registry/index.js";
import {
	AccessError,
	accessMessage,
	buildAccessRequest,
	decryptField,
	deriveRecordKey,
	encryptField,
	makeDeposit,
	newRepoKey,
	openField,
	requestKey,
	sealField,
	serveAccess,
	statement,
	verifyAccessRequest,
	type AccessRequest,
	type PaidScope,
} from "./paid.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

const REGISTRY = "0x00000000000000000000000000000000000000aa" as Address;
const publisher = privateKeyToAccount(generatePrivateKey());
const reader = privateKeyToAccount(generatePrivateKey());
const scope: PaidScope = {
	chainId: 84532,
	registry: REGISTRY,
	publisher: publisher.address,
	repo: ("0x" + "cd".repeat(32)) as Hex,
	generation: 0n,
};
const KEY_A = recordKey("a");
const KEY_B = recordKey("b");

const serverSecret = x25519.utils.randomSecretKey();
const server = { url: "https://keys.test", pubkey: x25519.getPublicKey(serverSecret) };

/** A key server in memory: serveAccess behind `fetch`, allowing whatever `allowed` holds. */
function keyServer(allowed: Set<string>) {
	const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
		expect(url).toBe(`${server.url}/access`);
		try {
			const body = JSON.parse(init?.body as string) as AccessRequest;
			const out = await serveAccess(body, {
				secret: serverSecret,
				chainId: scope.chainId,
				registry: REGISTRY,
				canRead: (r, _p, _repo, key) => Promise.resolve(allowed.has(`${r}:${key}`) || allowed.has(`${r}:${WHOLE_REPO}`)),
			});
			return Response.json(out);
		} catch (e) {
			if (e instanceof AccessError) return new Response(e.message, { status: e.status });
			throw e;
		}
	};
	return fetch as typeof globalThis.fetch;
}

describe("paid fields", () => {
	it("binds the statement to chain, registry, publisher, repo and generation", () => {
		const s = statement(scope);
		expect(statement({ ...scope })).toBe(s);
		for (const other of [
			{ ...scope, chainId: 1 },
			{ ...scope, registry: "0x00000000000000000000000000000000000000bb" as Address },
			{ ...scope, publisher: reader.address },
			{ ...scope, repo: ("0x" + "ab".repeat(32)) as Hex },
			{ ...scope, generation: 1n },
		]) {
			expect(statement(other)).not.toBe(s);
		}
	});

	it("a field opens only under its own record key, statement, record and field name", () => {
		const kRepo = newRepoKey();
		const stmt = statement(scope);
		const k = deriveRecordKey(kRepo, stmt, KEY_A);
		const ct = encryptField(k, enc.encode("body text"), stmt, KEY_A, "body");
		expect(dec.decode(decryptField(k, ct, stmt, KEY_A, "body"))).toBe("body text");

		expect(() => decryptField(deriveRecordKey(kRepo, stmt, KEY_B), ct, stmt, KEY_A, "body")).toThrow();
		expect(() => decryptField(k, ct, stmt, KEY_A, "title")).toThrow();
		expect(() => decryptField(k, ct, stmt, KEY_B, "body")).toThrow();
		expect(() => decryptField(k, ct, statement({ ...scope, generation: 1n }), KEY_A, "body")).toThrow();
	});

	describe("access requests", () => {
		const deposit = makeDeposit({ kRepo: newRepoKey(), keyServerPubkey: server.pubkey, keyServer: server.url, scope });
		const readerKey = bytesToHex(x25519.getPublicKey(x25519.utils.randomSecretKey()));
		const verify = { chainId: scope.chainId, registry: REGISTRY };

		it("recover the reader that signed them", async () => {
			const req = await buildAccessRequest({ signer: reader, deposit, key: KEY_A, readerKey });
			expect(await verifyAccessRequest(req, verify)).toBe(reader.address);
		});

		it("fail when a signed field changes", async () => {
			const req = await buildAccessRequest({ signer: reader, deposit, key: KEY_A, readerKey });
			for (const changed of [
				{ ...req, key: KEY_B },
				{ ...req, generation: "1" },
				{ ...req, publisher: reader.address },
				{ ...req, readerKey: ("0x" + "00".repeat(32)) as Hex },
			]) {
				expect(await verifyAccessRequest(changed, verify).catch(() => null)).not.toBe(reader.address);
			}
			// The same request checked against another chain or registry names someone else.
			expect(await verifyAccessRequest(req, { ...verify, chainId: 1 }).catch(() => null)).not.toBe(reader.address);
		});

		it("fail when stale", async () => {
			const req = await buildAccessRequest({ signer: reader, deposit, key: KEY_A, readerKey, timestamp: 1000 });
			await expect(verifyAccessRequest(req, { ...verify, now: 1061 })).rejects.toMatchObject({ status: 400 });
			expect(await verifyAccessRequest(req, { ...verify, now: 1060 })).toBe(reader.address);
		});

		it("hash every field they carry", () => {
			const stmt = statement(scope);
			expect(accessMessage(stmt, KEY_A, readerKey, 1)).not.toBe(accessMessage(stmt, KEY_A, readerKey, 2));
		});
	});

	describe("sealing and opening", () => {
		const kRepo = newRepoKey();
		const deposit = makeDeposit({ kRepo, keyServerPubkey: server.pubkey, keyServer: server.url, scope });
		const storage = new MemStorage();

		it("a record buyer opens the record, and nothing else", async () => {
			const handle = await sealField({ plaintext: enc.encode("the eagles are coming"), kRepo, scope, key: KEY_A, field: "body", storage });
			const other = await sealField({ plaintext: enc.encode("not yours"), kRepo, scope, key: KEY_B, field: "body", storage });
			// No key material in the record.
			expect(Object.keys(handle).sort()).toEqual(["@type", "cid", "gadget", "generation"]);

			const fetch = keyServer(new Set([`${reader.address}:${KEY_A}`]));
			const open = (h: typeof handle, key: Hex) => openField({ handle: h, deposit, key, field: "body", signer: reader, storage, fetch });

			await expect(open(handle, KEY_A).then((b) => dec.decode(b))).resolves.toBe("the eagles are coming");
			await expect(open(other, KEY_B)).rejects.toThrow(/403/);
			// Asking under record A for record B's ciphertext gets A's key, which can't open it.
			await expect(open(other, KEY_A)).rejects.toThrow();
			// A record buyer can't get the repo key.
			await expect(requestKey({ deposit, key: WHOLE_REPO, signer: reader, fetch })).rejects.toThrow(/403/);
		});

		it("refuses before the reader can read", async () => {
			const handle = await sealField({ plaintext: enc.encode("x"), kRepo, scope, key: KEY_A, field: "body", storage });
			await expect(
				openField({ handle, deposit, key: KEY_A, field: "body", signer: reader, storage, fetch: keyServer(new Set()) }),
			).rejects.toThrow(/403/);
		});

		it("a whole-repo buyer gets the repo key once and opens every record", async () => {
			const a = await sealField({ plaintext: enc.encode("a"), kRepo, scope, key: KEY_A, field: "body", storage });
			const b = await sealField({ plaintext: enc.encode("b"), kRepo, scope, key: KEY_B, field: "body", storage });
			const fetch = keyServer(new Set([`${reader.address}:${WHOLE_REPO}`]));

			const k = await requestKey({ deposit, key: WHOLE_REPO, signer: reader, fetch });
			const stmt = statement(scope);
			for (const [h, key, want] of [[a, KEY_A, "a"], [b, KEY_B, "b"]] as const) {
				const ct = await storage.getFile(h.cid);
				expect(dec.decode(decryptField(deriveRecordKey(k, stmt, key), ct, stmt, key, "body"))).toBe(want);
			}
		});

		it("the publisher gets its repo key back without buying", async () => {
			const fetch = keyServer(new Set());
			const k = await requestKey({ deposit, key: WHOLE_REPO, signer: publisher, fetch });
			expect(bytesToHex(k)).toBe(bytesToHex(kRepo));
		});

		it("a deposit made for another repo does not open", async () => {
			const elsewhere = makeDeposit({
				kRepo,
				keyServerPubkey: server.pubkey,
				keyServer: server.url,
				scope: { ...scope, repo: ("0x" + "ab".repeat(32)) as Hex },
			});
			const fetch = keyServer(new Set([`${reader.address}:${KEY_A}`]));
			// Swapped into this repo's request, it fails to unseal.
			await expect(
				requestKey({ deposit: { ...deposit, sealed: elsewhere.sealed }, key: KEY_A, signer: reader, fetch }),
			).rejects.toThrow(/400/);
		});

		it("a deposit for another registry does not open", async () => {
			const elsewhere = makeDeposit({
				kRepo,
				keyServerPubkey: server.pubkey,
				keyServer: server.url,
				scope: { ...scope, registry: "0x00000000000000000000000000000000000000bb" as Address },
			});
			const fetch = keyServer(new Set([`${reader.address}:${KEY_A}`]));
			await expect(requestKey({ deposit: elsewhere, key: KEY_A, signer: reader, fetch })).rejects.toThrow(/40[03]/);
		});
	});
});
