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

    async get<T>(uri: string): Promise<T> {
        return retrieveByCid<T>(uri);
    }

    static async getStatic<T>(uri: string): Promise<T> {
        return retrieveByCid<T>(uri);
    }

    async delete(uri: string): Promise<void> {
        await this.pinata.files.public.delete([uri]);
    }
}