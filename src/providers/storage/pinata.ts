import { PinataSDK } from "pinata";
import { MetadataStorage, StorageMeta } from "./types.js";
import { serialize, retrieveByCid } from "./utils.js";

export class PinataBackend implements MetadataStorage {
    private pinata: PinataSDK;
    private gateway: string;

    constructor(pinataJwt: string, pinataGateway: string) {
        this.pinata = new PinataSDK({ pinataJwt, pinataGateway });
        this.gateway = pinataGateway;
    }

    async put(data: unknown, meta?: StorageMeta): Promise<string> {
        const content = serialize(data);
        const file = new File([content], meta?.name ?? "file", { type: "text/plain" });
        const upload = await this.pinata.upload.public.file(file, { metadata: meta });
        return upload.cid;
    }

    async putMany(items: { data: unknown; name: string }[]): Promise<Record<string, string>> {
        if (items.length === 0) return {};

        const uriMap: Record<string, string> = {};

        // TODO: make this a parameter instead
        const PINATA_MAX_FILES = 1000;

        // Process the items in sub-batches of 500 to satisfy the free tier constraint
        for (let i = 0; i < items.length; i += PINATA_MAX_FILES) {
            const subBatch = items.slice(i, i + PINATA_MAX_FILES);

            // Convert data to standard browser-compatible File objects
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

                // Map this sub-batch's items to their correct folder path
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
        return retrieveByCid<T>(uri, this.gateway);
    }

    static async getStatic<T>(uri: string, gateway?: string): Promise<T> {
        return retrieveByCid<T>(uri, gateway);
    }

    async delete(uri: string): Promise<void> {
        await this.pinata.files.public.delete([uri]);
    }
}