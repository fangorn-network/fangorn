import { create } from "@storacha/client";
import type StorageProvider from "..";
import type { Client, EmailAddress, UnknownLink } from "@storacha/client/types";

export class StorachaStorage implements StorageProvider<unknown> {
	private client: Client;

	private constructor(client: Client) {
		this.client = client;
	}

	static async create(email: string): Promise<StorachaStorage> {
		const client = await create();
		const account = await client.login(email as EmailAddress);

		const plan = await account.plan.get();
		if (!plan.ok) {
			await account.plan.wait();
		}

		const spaces = client.spaces();
		if (spaces.length > 0) {
			await client.setCurrentSpace(spaces[0].did());
		} else {
			const space = await client.createSpace("fangorn", { account });
			await client.setCurrentSpace(space.did());
		}

		return new StorachaStorage(client);
	}

	async store(data: unknown, metadata?: Record<string, unknown>): Promise<string> {
		const content =
			typeof data === "string"
				? data
				: JSON.stringify(data, (_key, value) => {
						if (value instanceof Uint8Array) {
							return {
								__type: "Uint8Array",
								data: Buffer.from(value).toString("base64"),
							};
						}
						return value as unknown;
					});

		const name = typeof metadata?.name === "string" ? metadata.name : "file";
		const file = new File([content], name, { type: "text/plain" });
		const cid = await this.client.uploadFile(file);
		return cid.toString();
	}

	async retrieve(cid: string): Promise<unknown> {
		const url = `https://${cid}.ipfs.w3s.link`;
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`Failed to retrieve ${cid}: ${response.statusText}`);
		}
		const text = await response.text();
		return JSON.parse(text, (_key, value: unknown) => {
			if (
				value !== null &&
				typeof value === "object" &&
				"__type" in value &&
				"data" in value &&
				(value as { __type: unknown }).__type === "Uint8Array"
			) {
				return new Uint8Array(
					Buffer.from((value as { data: string }).data, "base64"),
				);
			}
			return value;
		});
	}

	async delete(cid: string): Promise<void> {
		await this.client.remove(cid as unknown as UnknownLink);
	}
}