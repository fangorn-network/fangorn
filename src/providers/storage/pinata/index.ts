import { PinataSDK } from "pinata";
import StorageProvider from "..";

export class PinataStorage implements StorageProvider<unknown> {
	private pinata: PinataSDK;
	private gateway: string;

	constructor(pinataJwt: string, pinataGateway: string) {
		this.pinata = new PinataSDK({ pinataJwt, pinataGateway });
		this.gateway = pinataGateway.replace(/\/$/, "");
	}

	async store(data: unknown, metadata?: Record<string, string>) {
		const content = typeof data === "string"
			? data
			: JSON.stringify(data, (_key, value) => {
				if (value instanceof Uint8Array) {
					return { __type: "Uint8Array", data: Buffer.from(value).toString("base64") };
				}
				return value;
			});

		const file = new File([content], metadata?.name ?? "file", { type: "text/plain" });
		const upload = await this.pinata.upload.public.file(file, { metadata });
		return upload.cid;
	}

	async retrieve(cid: string): Promise<unknown> {
		const url = `https://${this.gateway}/ipfs/${cid}`;
		console.log("retrieve url:", url);
		const response = await fetch(url);
		console.log("retrieve status:", response.status);
		const text = await response.text();
		console.log("retrieve body (first 200):", text.slice(0, 200));
		if (!response.ok) throw new Error(`Failed to retrieve ${cid}: ${response.statusText}`);
		return JSON.parse(text, (_key, value) => {
			if (value && typeof value === "object" && value.__type === "Uint8Array") {
				return new Uint8Array(Buffer.from(value.data, "base64"));
			}
			return value;
		});
	}

	async delete(cid: string): Promise<void> {
		await this.pinata.files.public.delete([cid]);
	}
}