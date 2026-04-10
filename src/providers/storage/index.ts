export * from "./pinata.js";

/**
 * A pinning service that stores content on IPFS and returns a CID.
 * Retrieval is always done via a public gateway — see retrieveByCid.
 */
export interface PinningService {
	store(data: unknown, metadata?: Record<string, unknown>): Promise<string>;
	delete(cid: string): Promise<void>;
}

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
	gateway = "https://ipfs.io"
): Promise<T> {
	const url = `${gateway.replace(/\/$/, "")}/ipfs/${cid}`;
	const controller = new AbortController();
	const timeout = setTimeout(() => { controller.abort(); }, 10_000);
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