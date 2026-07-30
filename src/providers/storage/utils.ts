import { CID } from "multiformats/cid";

export * from "./pinata.js";
export * from "./signed-url.js";

// Raw multicodec (0x55). Blocks written via putBlock() land under a raw-codec
// CID that shares the dag-cbor (0x71, "bafyrei…") CID's sha256 digest, so a
// dag-cbor CID must be translated to its raw sibling before a gateway fetch.
// See the RAW_CODE note in pinata.ts.
const RAW_CODE = 0x55;

// /**
//  * A pinning service that stores content on IPFS and returns a CID.
//  * Retrieval is always done via a public gateway — see retrieveByCid.
//  */
// export interface PinningService {
// 	store(data: unknown, metadata?: Record<string, unknown>): Promise<string>;
// 	delete(cid: string): Promise<void>;
// }

const REVIVERS: ((key: string, value: unknown) => unknown)[] = [
	(_key, value) => {
		if (
			value !== null &&
			typeof value === "object" &&
			"__type" in value &&
			"data" in value &&
			(value as { __type: unknown }).__type === "Uint8Array"
		) {
			return new Uint8Array(Buffer.from((value as { data: string }).data, "base64"));
		}
		return value;
	},
];

export function serialize(data: unknown): string {
	if (typeof data === "string") return data;
	return JSON.stringify(data, (_key, value) => {
		if (value instanceof Uint8Array) {
			return { __type: "Uint8Array", data: Buffer.from(value).toString("base64") };
		}
		return value as unknown;
	});
}

export function deserialize(text: string): unknown {
    return JSON.parse(text, (key, value: unknown) => {
        for (const reviver of REVIVERS) {
            const result = reviver(key, value);
            if (result !== value) return result;
        }
        return value;
    });
}

// Pinata's upload endpoint intermittently drops connections (HTTP 408 "client
// disconnected") and overloads (5xx/429), especially under parallel uploads on a
// modest uplink. A single chunk failing would otherwise abort an entire
// multi-chunk publish, so retry transient upload errors with exponential backoff.
export const MAX_UPLOAD_ATTEMPTS = Math.max(
	1,
	Number(process.env.PINATA_UPLOAD_RETRIES ?? 6),
);

export function isTransientUpload(err: unknown): boolean {
	const e = err as { statusCode?: number; code?: string; message?: string };
	const s = typeof e.statusCode === "number" ? e.statusCode : 0;
	if (s === 408 || s === 425 || s === 429 || s >= 500) return true;
	const m = `${e.code ?? ""} ${e.message ?? ""}`;
	return /HTTP_ERROR|disconnect|timed?\s?out|timeout|ECONN|ETIMEDOUT|EAI_AGAIN|socket hang up|network|fetch failed|terminated|aborted|429|408|50\d/i.test(
		m,
	);
}

export async function withUploadRetry<T>(
	label: string,
	fn: () => Promise<T>,
): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await fn();
		} catch (err) {
			if (attempt >= MAX_UPLOAD_ATTEMPTS || !isTransientUpload(err)) throw err;
			const delay =
				Math.min(30_000, 500 * 2 ** (attempt - 1)) +
				Math.floor(Math.random() * 500);
			console.warn(
				`  [upload] "${label}" failed (attempt ${attempt.toString()}/${MAX_UPLOAD_ATTEMPTS.toString()}), retrying in ${(delay / 1000).toFixed(1)}s: ${(err as Error).message}`,
			);
			await new Promise((r) => setTimeout(r, delay));
		}
	}
}

/**
 * Build the gateway URL for a CID (optionally path-style, `ipfs://cid/name`).
 *
 * The CID reaches us from remote data — a commit block, a namespace payload —
 * so it is untrusted input pasted into a URL: reject relative segments and any
 * scheme-bearing value that would redirect the fetch off the gateway, then
 * percent-encode what remains.
 */
export function gatewayUrl(gateway: string | undefined, cid: string): string {
	// Gateways may be passed as a bare host (e.g. "foo.mypinata.cloud") — give
	// them a scheme so `fetch` gets an absolute URL. An empty gateway falls
	// back to the public one.
	const base = (gateway?.trim() ? gateway : "https://ipfs.io").replace(/\/$/, "");
	const origin = /^https?:\/\//.test(base) ? base : `https://${base}`;

	// CIDs may arrive as raw ("bafy…") or path-style ("ipfs://cid/path").
	const path = cid.replace(/^ipfs:\/\//, "");
	const segments = path.split("/").filter((s) => s.length > 0);
	if (
		segments.length === 0 ||
		segments.some((s) => s === "." || s === "..") ||
		/^[a-z][a-z0-9+.-]*:/i.test(path) ||
		path.startsWith("//")
	) {
		throw new Error(`Refusing to fetch malformed content path: ${cid}`);
	}

	return `${origin}/ipfs/${segments.map(encodeURIComponent).join("/")}`;
}

/**
 * Fetch the exact raw bytes for a CID from a public IPFS gateway (no decoding),
 * retrying to ride out gateway replication lag right after an upload. Blocks
 * written via putBlock() are addressed by their raw-codec (0x55) sibling, so a
 * dag-cbor ("bafyrei…") CID is translated before fetching — the same handling
 * PinataBackend.fetchRaw does, but over a public gateway with no JWT.
 */
export async function fetchRawByCid(
	cid: string,
	gateway = "https://ipfs.io",
	{ retries = 5, timeoutMs = 16_000 } = {},
): Promise<Uint8Array> {
	let fetchCid = cid.replace(/^ipfs:\/\//, "");
	if (fetchCid.startsWith("bafyrei")) {
		try {
			fetchCid = CID.createV1(RAW_CODE, CID.parse(fetchCid).multihash).toString();
		} catch {
			/* not a parseable CID — fetch it verbatim */
		}
	}

	const url = gatewayUrl(gateway, fetchCid);

	let lastError: unknown;
	for (let attempt = 0; attempt < retries; attempt++) {
		const controller = new AbortController();
		const timeout = setTimeout(() => { controller.abort(); }, timeoutMs);
		try {
			const res = await fetch(url, { signal: controller.signal });
			if (!res.ok) throw new Error(`HTTP ${res.status.toString()} ${res.statusText}`);
			return new Uint8Array(await res.arrayBuffer());
		} catch (err) {
			lastError = err;
			// Let the gateway ledger sync before retrying (replication lag / 4xx).
			if (attempt < retries - 1) await new Promise((r) => setTimeout(r, 1000));
		} finally {
			clearTimeout(timeout);
		}
	}
	throw new Error(
		`Failed to retrieve ${cid} from ${url} after ${retries.toString()} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
	);
}

/**
 * Fetch any content by CID from a public IPFS gateway.
 * No auth required — all Fangorn content is public; privacy is cryptographic.
 */
export async function retrieveByCid<T>(
	cid: string,
	gateway = "https://ipfs.io",
	timeoutSecond = 16_000,
): Promise<T> {
	const url = gatewayUrl(gateway, cid);
	const controller = new AbortController();
	const timeout = setTimeout(() => { controller.abort(); }, timeoutSecond);
	try {
		const res = await fetch(url, { signal: controller.signal });
		if (!res.ok) throw new Error(`Failed to retrieve ${cid}: ${res.statusText}`);
		return deserialize(await res.text()) as T;
	} catch (err) {
		if ((err as Error).name === "AbortError") {
			throw new Error(`Timed out retrieving ${cid} from ${url}`);
		}
		throw err;
	} finally {
		clearTimeout(timeout);
	}
}