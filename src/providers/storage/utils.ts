import { CID } from "multiformats/cid";
import { errorMessage, sleep } from "../../utils/index.js";

export * from "./pinata.js";
export * from "./signed-url.js";

// Raw multicodec (0x55). Blocks written via putBlock() land under a raw-codec
// CID that shares the dag-cbor (0x71, "bafyrei…") CID's sha256 digest, so a
// dag-cbor CID must be translated to its raw sibling before a gateway fetch.
// See the RAW_CODE note in pinata.ts.
export const RAW_CODE = 0x55;

/**
 * Translate a block reference into the CID a gateway actually serves it under:
 * blocks written via putBlock() are addressed by their raw-codec (0x55) sibling,
 * which shares the dag-cbor ("bafyrei…") CID's digest. Unparseable or non-
 * dag-cbor references pass through verbatim.
 */
export function rawBlockRef(ref: string): {
	fetchCid: string;
	isDagCborCid: boolean;
} {
	const isDagCborCid = ref.startsWith("bafyrei");
	if (!isDagCborCid) return { fetchCid: ref, isDagCborCid };
	try {
		return {
			fetchCid: CID.createV1(RAW_CODE, CID.parse(ref).multihash).toString(),
			isDagCborCid,
		};
	} catch {
		/* not a parseable CID — fetch it verbatim */
		return { fetchCid: ref, isDagCborCid };
	}
}

/**
 * The gateway URL for a CID or `ipfs://` path. Gateways may arrive as a bare
 * host (e.g. "foo.mypinata.cloud"), so give them a scheme — `fetch` needs an
 * absolute URL — and fall back to the public gateway when blank.
 */
export function gatewayUrl(cid: string, gateway: string): string {
	const base = (gateway || "https://ipfs.io").replace(/\/$/, "");
	const origin = /^https?:\/\//.test(base) ? base : `https://${base}`;
	return `${origin}/ipfs/${cid.replace(/^ipfs:\/\//, "")}`;
}

/**
 * Decode a text payload the way the Pinata SDK would have handed it back: JSON
 * when it parses, otherwise the raw string.
 */
export function decodeJsonOrText(bytes: Uint8Array): unknown {
	const text = new TextDecoder().decode(bytes);
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

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
				`  [upload] "${label}" failed (attempt ${attempt.toString()}/${MAX_UPLOAD_ATTEMPTS.toString()}), retrying in ${(delay / 1000).toFixed(1)}s: ${errorMessage(err)}`,
			);
			await sleep(delay);
		}
	}
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
	const { fetchCid } = rawBlockRef(cid.replace(/^ipfs:\/\//, ""));
	const url = gatewayUrl(fetchCid, gateway);

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
			if (attempt < retries - 1) await sleep(1000);
		} finally {
			clearTimeout(timeout);
		}
	}
	throw new Error(
		`Failed to retrieve ${cid} from ${url} after ${retries.toString()} attempts: ${errorMessage(lastError)}`,
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
	// CIDs may arrive as raw ("bafy…") or path-style ("ipfs://cid/path").
	const url = gatewayUrl(cid, gateway);
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