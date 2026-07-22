import { Hex } from "viem";
import { MetadataStorage, RawBlock, StorageMeta } from "./types.js";
import { serialize, fetchRawByCid, withUploadRetry } from "./utils.js";

/**
 * The hosted pinata-url-provider worker. Used when no worker URL is supplied, so
 * callers can upload via signed URLs with zero configuration. Point at your own
 * deployment by passing a workerUrl.
 */
export const DEFAULT_SIGNED_URL_WORKER =
	"https://pinata-url-provider.fangorn-0be.workers.dev";

interface WorkerResponse {
	ok?: boolean;
	challenge?: string;
	uploadUrl?: string;
	network?: string;
	error?: string;
	// The worker attaches this to 502s (e.g. why minting the Pinata URL failed) —
	// the actionable half of the message, so never drop it.
	detail?: string;
}

/** A human-readable reason from a worker error response, detail included. */
function workerError(r: WorkerResponse): string {
	const base = r.error ?? "unknown error";
	return r.detail ? `${base} (${r.detail})` : base;
}

/** Just enough of a wallet to run the worker's ownership handshake. */
export interface SignedUrlSigner {
	address: Hex;
	/** EIP-191 personal_sign of `message` (what the worker recovers against). */
	signMessage(message: string): Promise<Hex>;
}

/**
 * Storage backend for users who don't bring their own Pinata JWT.
 *
 * Uploads go through the pinata-url-provider Worker: prove wallet ownership by
 * signing the worker's challenge, and it hands back a short-lived, single-use
 * Pinata presigned upload URL that we POST the file to — the JWT never leaves
 * the worker. Reads need no auth: every Fangorn block is public content, so we
 * fetch it straight from a public IPFS gateway by CID (privacy is cryptographic,
 * not access-controlled). Each upload runs a fresh handshake because the
 * presigned URL is one-time and expires in minutes.
 *
 * JWT-only operations (server-side metadata queries / deletes) are unavailable
 * here — switch to a PinataBackend (your own JWT) if you need them.
 */
export class SignedUrlBackend implements MetadataStorage {
	private readonly workerUrl: string;

	constructor(
		workerUrl: string | undefined,
		private readonly signer: SignedUrlSigner,
		private readonly gateway: string,
	) {
		// Blank/whitespace (e.g. an unset CLI field) falls back to the default —
		// so `??` alone won't do, it wouldn't catch "".
		this.workerUrl = workerUrl?.trim() ? workerUrl : DEFAULT_SIGNED_URL_WORKER;
	}

	/** Run the worker challenge handshake → one-time presigned upload URL + network. */
	private async requestUploadUrl(
		size: number,
		uploadId: string,
	): Promise<{ uploadUrl: string; network: string }> {
		const address = this.signer.address;

		// 1) Ask for the challenge to sign, declaring the upload size up front so
		// the worker mints a presigned URL scoped to exactly this many bytes. The
		// uploadId lets the worker charge one logical upload once across retries.
		const challenge = await this.workerJson({ address, size, uploadId });
		if (!challenge.challenge) {
			throw new Error(
				`Presigned-URL worker did not issue a challenge: ${workerError(challenge)}`,
			);
		}

		// 2) Sign it and resend (with the size + uploadId) to claim the presigned URL.
		const signature = await this.signer.signMessage(challenge.challenge);
		const grant = await this.workerJson({
			address,
			message: challenge.challenge,
			signature,
			size,
			uploadId,
		});
		if (!grant.ok || !grant.uploadUrl) {
			throw new Error(
				`Presigned-URL worker denied an upload URL: ${workerError(grant)}`,
			);
		}
		return { uploadUrl: grant.uploadUrl, network: grant.network ?? "public" };
	}

	private async workerJson(body: Record<string, unknown>): Promise<WorkerResponse> {
		const res = await fetch(this.workerUrl, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		const json = (await res.json().catch(() => null)) as WorkerResponse | null;
		return json ?? { error: `HTTP ${res.status.toString()}` };
	}

	/** Upload bytes via a fresh one-time presigned URL; returns the pinned CID. */
	private uploadBytes(bytes: Uint8Array, name: string, type: string): Promise<string> {
		// One idempotency id per logical upload, shared across retries. A transient
		// failure re-mints a fresh (single-use) URL, but the worker dedupes the
		// storage-budget debit by this id, so the retry isn't charged again.
		const uploadId = globalThis.crypto.randomUUID();
		return withUploadRetry(name, async () => {
			// A fresh URL per attempt: presigned URLs are single-use and short-lived.
			// Declare the exact byte length so the worker scopes the URL to it.
			const { uploadUrl, network } = await this.requestUploadUrl(bytes.length, uploadId);
			const fd = new FormData();
			fd.append("network", network);
			fd.append("file", new File([bytes as BlobPart], name, { type }));

			const res = await fetch(uploadUrl, { method: "POST", body: fd });
			const data = (await res.json().catch(() => null)) as {
				data?: { cid?: string };
			} | null;
			if (!res.ok) {
				throw Object.assign(
					new Error(`Pinata upload failed: ${data ? JSON.stringify(data) : "(no body)"}`),
					{ statusCode: res.status },
				);
			}
			const cid = data?.data?.cid;
			if (!cid) throw new Error(`Pinata upload returned no CID: ${JSON.stringify(data)}`);
			return cid;
		});
	}

	async put(data: unknown, meta?: StorageMeta): Promise<string> {
		return this.uploadBytes(
			new TextEncoder().encode(serialize(data)),
			meta?.name ?? "file",
			"text/plain",
		);
	}

	async putFile(bytes: Uint8Array, name: string): Promise<string> {
		return this.uploadBytes(bytes, name, "application/octet-stream");
	}

	async putBlock(block: RawBlock): Promise<void> {
		await this.uploadBytes(
			block.bytes,
			block.cid.toString(),
			"application/octet-stream",
		);
	}

	async getFile(uri: string): Promise<Uint8Array> {
		return fetchRawByCid(uri, this.gateway);
	}

	async getRawBlock(uri: string): Promise<Uint8Array> {
		return fetchRawByCid(uri, this.gateway);
	}

	async get<T>(uri: string): Promise<T> {
		const bytes = await fetchRawByCid(uri, this.gateway);
		const text = new TextDecoder().decode(bytes);
		try {
			return JSON.parse(text) as T;
		} catch {
			return text as unknown as T;
		}
	}

	// CAR (`.car()`) uploads and account-scoped metadata/deletes need the Pinata
	// JWT directly, which signed-url callers don't have. Fail loudly rather than
	// silently no-op; these are off the core publish/read path (the engine only
	// uses put/get File + Block).
	putMany(): Promise<Record<string, string>> {
		throw new Error(
			"putMany (batched CAR upload) is not available with signed URLs — provide your own Pinata JWT.",
		);
	}

	delete(): Promise<void> {
		throw new Error(
			"delete is not available with signed URLs — provide your own Pinata JWT.",
		);
	}
}
