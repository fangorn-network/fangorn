import { PinataSDK } from "pinata";
import { CID } from "multiformats";
import { sha256 } from "multiformats/hashes/sha2";
import * as raw from "multiformats/codecs/raw";
import { CarWriter } from "@ipld/car";
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
                const batchName = `batch-${Date.now().toString()}-${i}`;
                const upload = await this.pinata.upload.public
                    .fileArray(filesToUpload)
                    .name(batchName);

                const folderCid = upload.cid;

                // 3. Map this sub-batch's items to their correct folder path
                for (const { name } of subBatch) {
                    uriMap[name] = `ipfs://${folderCid}/manifests/${name}.json`;
                }

            } catch (error) {
                console.error(`❌ Pinata sub-batch upload failure at offset ${i}:`, error);
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