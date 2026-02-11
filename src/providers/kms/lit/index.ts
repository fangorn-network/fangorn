import { createLitClient } from "@lit-protocol/lit-client";
import {
	DecryptParams,
	DecryptResult,
	EncryptParams,
	EncryptResult,
	KMSProvider,
	KMSProviderConfig,
} from "..";
import { nagaDev } from "@lit-protocol/networks";

export class LitKMSProvider implements KMSProvider {
	readonly name = "lit";
	private litClient: any = null;
	private connected = false;
	private config: KMSProviderConfig;

	constructor(config: KMSProviderConfig) {
		this.config = config;
	}

	async connect(): Promise<void> {
		try {
			this.litClient = await createLitClient({
				network: nagaDev,
			});
			this.connected = true;
		} catch (error) {
			throw new Error(
				`Failed to connect to Lit: ${error instanceof Error ? error.message : error}`,
			);
		}
	}

	async disconnect(): Promise<void> {
		if (this.litClient) {
			await this.litClient.disconnect();
		}
		this.connected = false;
	}

	isConnected(): boolean {
		return this.connected;
	}

	async encrypt(params: EncryptParams): Promise<EncryptResult> {
		if (!this.litClient) throw new Error("Not connected");

		const dataBytes =
			typeof params.data === "string"
				? new TextEncoder().encode(params.data)
				: params.data;

		const { ciphertext, dataToEncryptHash } = await this.litClient.encrypt({
			dataToEncrypt: dataBytes,
			unifiedAccessControlConditions: params.accessControlConditions,
			chain: params.chain,
		});

		return {
			ciphertext,
			dataHash: dataToEncryptHash,
		};
	}

	async decrypt(params: DecryptParams): Promise<DecryptResult> {
		if (!this.litClient) throw new Error("Not connected");

		try {
			const result = await this.litClient.executeJs({
				code: params.litActionCode,
				ipfsId: params.litActionIpfsCid,
				jsParams: {
					...params.jsParams,
					ciphertext: params.ciphertext,
					dataToEncryptHash: params.dataHash,
				},
				authContext: params.authContext,
			});

			// Parse the response from the Lit Action
			if (result.response) {
				try {
					const parsed = JSON.parse(result.response);
					if (parsed.success && parsed.decrypted) {
						return {
							success: true,
							data: new TextEncoder().encode(parsed.decrypted),
							logs: result.logs,
						};
					} else {
						return {
							success: false,
							error: parsed.error || "Decryption failed",
							logs: result.logs,
						};
					}
				} catch {
					// Response might be raw decrypted data
					return {
						success: true,
						data: new TextEncoder().encode(result.response),
						logs: result.logs,
					};
				}
			}

			return {
				success: false,
				error: "No response from Lit Action",
				logs: result.logs,
			};
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async uploadAction(code: string): Promise<string> {
		// In real implementation, upload to IPFS
		// For now, throw - caller should handle IPFS upload separately
		throw new Error("IPFS upload not implemented - use external IPFS service");
	}
}
