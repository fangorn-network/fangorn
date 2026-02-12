import { PinataSDK } from "pinata";
import StorageProvider from "..";

export class PinataStorage implements StorageProvider<any> {
	constructor(private pinata: PinataSDK) {}

	async store(data: any, metadata?: Record<string, unknown>) {
		const upload = await this.pinata.upload.public.json(data, { metadata });
		return upload.cid;
	}

	async retrieve(cid: string) {
		const response = await this.pinata.gateways.public.get(cid);
		return response.data;
	}

	async delete(cid: string): Promise<void> {
		await this.pinata.files.public.delete([cid]);
	}
}
