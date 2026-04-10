import { PinataSDK } from "pinata";
import { PinningService, serialize } from "./index";

export class PinataStorage implements PinningService {
    private pinata: PinataSDK;

    constructor(pinataJwt: string, pinataGateway: string) {
        this.pinata = new PinataSDK({ pinataJwt, pinataGateway });
    }

    async store(data: unknown, metadata?: Record<string, unknown>): Promise<string> {
        const content = serialize(data);
        const file = new File([content], (metadata ?? { name: "file" }).name as string, {
            type: "text/plain",
        });
        const upload = await this.pinata.upload.public.file(file, { metadata });
        return upload.cid;
    }

    async delete(cid: string): Promise<void> {
        await this.pinata.files.public.delete([cid]);
    }
}