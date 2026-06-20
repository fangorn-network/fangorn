import { PinataSDK } from "pinata";
import { MetadataStorage, StorageMeta } from "./types.js";
import { serialize, retrieveByCid } from "./utils.js";

// Pinata's upload endpoint intermittently drops connections (HTTP 408 "client
// disconnected") and overloads (5xx/429), especially under parallel uploads on a
// modest uplink. A single chunk failing would otherwise abort an entire
// multi-chunk publish, so retry transient upload errors with exponential backoff.
const MAX_UPLOAD_ATTEMPTS = Math.max(1, Number(process.env.PINATA_UPLOAD_RETRIES ?? 6));

function isTransientUpload(err: unknown): boolean {
    const e = err as { statusCode?: number; code?: string; message?: string };
    const s = typeof e.statusCode === "number" ? e.statusCode : 0;
    if (s === 408 || s === 425 || s === 429 || s >= 500) return true;
    const m = `${e.code ?? ""} ${e.message ?? ""}`;
    return /HTTP_ERROR|disconnect|timed?\s?out|timeout|ECONN|ETIMEDOUT|EAI_AGAIN|socket hang up|network|fetch failed|terminated|aborted|429|408|50\d/i.test(m);
}

async function withUploadRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        try { return await fn(); }
        catch (err) {
            if (attempt >= MAX_UPLOAD_ATTEMPTS || !isTransientUpload(err)) throw err;
            const delay = Math.min(30_000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
            console.warn(`  [pinata] upload "${label}" failed (attempt ${attempt.toString()}/${MAX_UPLOAD_ATTEMPTS.toString()}), retrying in ${(delay / 1000).toFixed(1)}s: ${(err as Error).message}`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
}

export class PinataBackend implements MetadataStorage {
    private pinata: PinataSDK;
    private gateway: string;

    constructor(pinataJwt: string, pinataGateway: string) {
        this.pinata = new PinataSDK({ pinataJwt, pinataGateway });
        this.gateway = pinataGateway;
    }

    async put(data: unknown, meta?: StorageMeta): Promise<string> {
        const content = serialize(data);
        const name = meta?.name ?? "file";
        return withUploadRetry(name, async () => {
            const file = new File([content], name, { type: "text/plain" });
            const upload = await this.pinata.upload.public.file(file, { metadata: meta });
            return upload.cid;
        });
    }

    async putMany(items: { data: unknown; name: string }[]): Promise<Record<string, string>> {
        if (items.length === 0) return {};

        const uriMap: Record<string, string> = {};

        // Pinata free tier max file array limit per HTTP request
        const PINATA_MAX_FILES = 500;

        // Process the items in sub-batches of 500 to satisfy the free tier constraint
        for (let i = 0; i < items.length; i += PINATA_MAX_FILES) {
            const subBatch = items.slice(i, i + PINATA_MAX_FILES);

            // 1. Convert data to standard browser-compatible File objects
            const filesToUpload = subBatch.map(({ data, name }) => {
                const content = typeof data === "string" ? data : JSON.stringify(data);

                // Keep the relative sub-path layout to force directory wrapping
                return new File(
                    [content],
                    `manifests/${name}.json`,
                    { type: "application/json" }
                );
            });

            try {
                // 2. Upload this sub-batch as an independent folder
                const batchName = `batch-${Date.now().toString()}-${i.toString()}`;
                const upload = await this.pinata.upload.public
                    .fileArray(filesToUpload)
                    .name(batchName);

                const folderCid = upload.cid;

                // 3. Map this sub-batch's items to their correct folder path
                for (const { name } of subBatch) {
                    uriMap[name] = `ipfs://${folderCid}/manifests/${name}.json`;
                }

            } catch (error) {
                console.error(`❌ Pinata sub-batch upload failure at offset ${i.toString()}:`, error);
                throw error;
            }
        }

        return uriMap;
    }

    async get<T>(uri: string): Promise<T> {
        // Use the dedicated Pinata gateway — freshly pinned content is served
        // immediately there, whereas the public ipfs.io gateway lags propagation
        // and times out on just-published CIDs.
        return retrieveByCid<T>(uri, this.gateway);
    }

    static async getStatic<T>(uri: string, gateway?: string): Promise<T> {
        return retrieveByCid<T>(uri, gateway);
    }

    async delete(uri: string): Promise<void> {
        await this.pinata.files.public.delete([uri]);
    }
}