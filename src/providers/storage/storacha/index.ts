import { create } from "@storacha/client";
import StorageProvider from "..";
import { Client, EmailAddress, UnknownLink } from "@storacha/client/types";

export class StorachaStorage implements StorageProvider<unknown> {
    private client: Client;
    private storachaGateway: string;

    async init(email: string, storachaGateway: string): Promise<StorachaStorage> {

        const client = await create();
        await client.login(email as EmailAddress);

        // If an account hasn't been made, then this will be used to create an account.
        // const account = await client.login(email as EmailAddress);

        // Accounts require a payment plan. This polls until one is set up.
        // await account.plan.wait();

        // Spaces can be created as well
        // const space = await client.createSpace("Fangorn.Music", { account });

        return new StorachaStorage(client, storachaGateway);

    }

	constructor(client: Client, storachaGateway: string) {

        this.client = client;
        this.storachaGateway = storachaGateway;
        
	}

	async store(data: unknown, metadata?: Record<string, string>) {
		const content = typeof data === "string"
			? data
			: JSON.stringify(data, (_key, value) => {
				if (value instanceof Uint8Array) {
					return { __type: "Uint8Array", data: Buffer.from(value).toString("base64") };
				}
				return value as Record<string, string>;
			});

		const file = new File([content], metadata?.name ?? "file", { type: "text/plain" });
		const upload = await this.client.uploadFile(file);
        const cid = upload.toString();
		return cid[0];
	}

	async retrieve(cid: string): Promise<unknown> {
		const url = `https://${cid}.ipfs.${this.storachaGateway}`;
		const response = await fetch(url);
		const text = await response.text();
		if (!response.ok) throw new Error(`Failed to retrieve ${cid}: ${response.statusText}`);
		return JSON.parse(text, (_key, value: unknown) => {
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
		});
	}

	async delete(cid: string): Promise<void> {
		await this.client.remove(cid as unknown as UnknownLink);
	}
}