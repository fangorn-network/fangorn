import { CID } from "multiformats/cid";
import { Hex } from "viem";
import { FangornConfig } from "../../config.js";
import {
	assertStoredBlock,
	assertStoredFile,
	MetadataStorage,
	RawBlock,
	StorageMeta,
} from "./types.js";
import { serialize, fetchRawByCid, withUploadRetry } from "./utils.js";

/**
 * The hosted worker for the default network (Base Sepolia). Used when neither
 * a worker URL nor the network's config names one. `Fangorn.create` passes the
 * config's `signedUrlWorker`, so a Base client reaches Base's worker.
 */
export const DEFAULT_SIGNED_URL_WORKER = FangornConfig.signedUrlWorker;

/** The worker's handshake is two tiny JSON round trips. */
const WORKER_TIMEOUT_MS = 30_000;

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
 * Uploads go through the pinata-url-provider Worker. Prove wallet ownership by
 * signing the worker's challenge, and it hands back a short-lived, single-use
 * Pinata presigned upload URL that users POST the file to.
 * Reads need no auth: every Fangorn block is public content, so it's
 * fetched straight from a public IPFS gateway by CID (privacy is cryptographic,
 * not access-controlled). Each upload runs a fresh handshake because the
 * presigned URL is one-time and expires in minutes.
 *
 * JWT-only operations (server-side metadata queries / deletes) are unavailable
 * here. Switch to a PinataBackend they're needed.
 *
 * Every upload is charged to the signing publisher's storage quota.
 */
export class SignedUrlBackend implements MetadataStorage {
	// null: the chain has no hosted worker. Reads still work (they go to the
	// gateway); uploads are refused rather than sent to another chain's worker.
	private readonly workerUrl: string | null;

	constructor(
		workerUrl: string | null | undefined,
		private readonly signer: SignedUrlSigner,
		private readonly gateway: string,
	) {
		// Blank/whitespace (e.g. an unset CLI field) falls back to the default —
		// so `??` alone won't do, it wouldn't catch "".
		this.workerUrl =
			workerUrl === null
				? null
				: workerUrl?.trim()
					? workerUrl
					: DEFAULT_SIGNED_URL_WORKER;
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
			throw Object.assign(
				new Error(
					`Presigned-URL worker did not issue a challenge: ${workerError(challenge)}`,
				),
				{ statusCode: challenge.status },
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
			throw Object.assign(
				new Error(
					`Presigned-URL worker denied an upload URL: ${workerError(grant)}`,
				),
				{ statusCode: grant.status },
			);
		}
		return { uploadUrl: grant.uploadUrl, network: grant.network ?? "public" };
	}

	private async workerJson(
		body: Record<string, unknown>,
	): Promise<WorkerResponse & { status: number }> {
		// Worded to stay out of isTransientUpload's patterns, so it fails at once.
		if (!this.workerUrl)
			throw new Error(
				"no hosted upload worker on this chain: pass storage.signedUrl.workerUrl, or bring your own storage ({ pinata } or { backend })",
			);
		const res = await fetch(this.workerUrl, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			// A stalled worker would otherwise hang the publish forever; a timeout
			// reads as transient, so withUploadRetry tries again.
			signal: AbortSignal.timeout(WORKER_TIMEOUT_MS),
		});
		const json = (await res.json().catch(() => null)) as WorkerResponse | null;
		// The status rides along so a 429/5xx with a JSON body still reads as
		// transient to withUploadRetry, not only a bodiless one.
		return {
			...(json ?? { error: `HTTP ${res.status.toString()}` }),
			status: res.status,
		};
	}

	/** Upload bytes via a fresh one-time presigned URL; returns the pinned CID. */
	private uploadBytes(
		bytes: Uint8Array,
		name: string,
		type: string,
	): Promise<string> {
		// One idempotency id per logical upload, shared across retries. A transient
		// failure re-mints a fresh (single-use) URL, but the worker dedupes the
		// storage-budget debit by this id, so the retry isn't charged again.
		const uploadId = globalThis.crypto.randomUUID();
		return withUploadRetry(name, async () => {
			// A fresh URL per attempt: presigned URLs are single-use and short-lived.
			// Declare the exact byte length so the worker scopes the URL to it.
			const { uploadUrl, network } = await this.requestUploadUrl(
				bytes.length,
				uploadId,
			);
			const fd = new FormData();
			fd.append("network", network);
			fd.append("file", new File([bytes as BlobPart], name, { type }));

			const res = await fetch(uploadUrl, { method: "POST", body: fd });
			const data = (await res.json().catch(() => null)) as {
				data?: { cid?: string };
			} | null;
			if (!res.ok) {
				throw Object.assign(
					new Error(
						`Pinata upload failed: ${data ? JSON.stringify(data) : "(no body)"}`,
					),
					{ statusCode: res.status },
				);
			}
			const cid = data?.data?.cid;
			if (!cid)
				throw new Error(
					`Pinata upload returned no CID: ${JSON.stringify(data)}`,
				);
			return cid;
		});
	}

	async put(data: unknown, meta?: StorageMeta): Promise<string> {
		const bytes = new TextEncoder().encode(serialize(data));
		const cid = await this.uploadBytes(
			bytes,
			meta?.name ?? "file",
			"text/plain",
		);
		await assertStoredFile(cid, bytes, this);
		return cid;
	}

	async putFile(bytes: Uint8Array, name: string): Promise<string> {
		const cid = await this.uploadBytes(bytes, name, "application/octet-stream");
		await assertStoredFile(cid, bytes, this);
		return cid;
	}

	async putBlock(block: RawBlock): Promise<void> {
		assertStoredBlock(
			await this.uploadBytes(
				block.bytes,
				block.cid.toString(),
				"application/octet-stream",
			),
			block,
		);
	}

	async getFile(uri: string): Promise<Uint8Array> {
		return fetchRawByCid(uri, this.gateway);
	}

	async getRawBlock(uri: string): Promise<Uint8Array> {
		return fetchRawByCid(uri, this.gateway, {
			rawBlock: CID.parse(uri.replace(/^ipfs:\/\//, "")).code === 0x70,
		});
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
