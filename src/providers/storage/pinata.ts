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

        const encoder = new TextEncoder();

        // Serialize each item and compute its CID deterministically.
        // Using raw codec — same bytes as put(), same gateway behavior.
        const blocks: Array<{ name: string; cid: CID; bytes: Uint8Array }> = [];
        for (const { data, name } of items) {
            const bytes = encoder.encode(serialize(data));
            const hash = await sha256.digest(bytes);
            const cid = CID.create(1, raw.code, hash);
            blocks.push({ name, cid, bytes });
        }

        // CarWriter streams output — must drain concurrently with writes
        // or the internal buffer will deadlock on large payloads.
        const { writer, out } = CarWriter.create([blocks[0].cid]);

        const chunks: Uint8Array[] = [];
        const drain = (async () => {
            for await (const chunk of out) chunks.push(chunk);
        })();

        for (const { cid, bytes } of blocks) {
            await writer.put({ cid, bytes });
        }
        await writer.close();
        await drain;

        const carFile = new File(
            [new Blob(chunks.map(c => c.buffer.slice(c.byteOffset, c.byteOffset + c.byteLength) as ArrayBuffer))],
            `bundle-${Date.now()}.car`,
            { type: "application/vnd.ipld.car" }
        );

        await this.pinata.upload.public.file(carFile, {
            metadata: { name: `car:${Date.now()}` },
        });

        return Object.fromEntries(blocks.map(({ name, cid }) => [name, cid.toString()]));
    }

    async get<T>(uri: string): Promise<T> {
        return retrieveByCid<T>(uri);
    }

    static async getStatic<T>(uri: string, gateway?: string): Promise<T> {
        return retrieveByCid<T>(uri, gateway);
    }

    async delete(uri: string): Promise<void> {
        await this.pinata.files.public.delete([uri]);
    }
}