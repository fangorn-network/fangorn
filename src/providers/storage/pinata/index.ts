import { PinataSDK } from "pinata";
import StorageProvider from "..";

export class PinataStorage implements StorageProvider<any> {
	constructor(private pinata: PinataSDK) {}

	async store(data: any, metadata?: Record<string, unknown>) {
		const content = typeof data === "string" ? data : JSON.stringify(data);
		const file = new File([content], (metadata as any)?.name ?? "file", {
			type: "text/plain",
		});
		const upload = await this.pinata.upload.public.file(file, { metadata });
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
