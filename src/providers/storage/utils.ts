export * from "./pinata.js";

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

/**
 * Fetch any content by CID from a public IPFS gateway.
 * No auth required — all Fangorn content is public; privacy is cryptographic.
 */
export async function retrieveByCid<T>(
	cid: string,
	gateway = "https://ipfs.io",
	timeoutSecond = 16_000,
): Promise<T> {
	// Gateways may be passed as a bare host (e.g. "foo.mypinata.cloud") — give
	// them a scheme so `fetch` gets an absolute URL. An empty gateway falls
	// back to the public one.
	const base = (gateway || "https://ipfs.io").replace(/\/$/, "");
	const origin = /^https?:\/\//.test(base) ? base : `https://${base}`;
	// CIDs may arrive as raw ("bafy…") or path-style ("ipfs://cid/path").
	const path = cid.replace(/^ipfs:\/\//, "");
	const url = `${origin}/ipfs/${path}`;
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