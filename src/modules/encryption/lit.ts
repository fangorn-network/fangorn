import { createSiweMessage } from "@lit-protocol/auth-helpers";
import {
	LitAccessControlConditionResource,
	LitActionResource,
	LitPKPResource,
} from "@lit-protocol/auth-helpers";
import { createLitClient, type LitClient } from "@lit-protocol/lit-client";
import { createAuthManager, storagePlugins } from "@lit-protocol/auth";
import { type WalletClient } from "viem";
import { nagaDev } from "@lit-protocol/networks";

import { encryptData, decryptData } from "./aes.js";
import type {
	EncryptedPayload,
	DecryptedPayload,
	AuthContextWrapper,
	AuthSig,
} from "./types.js";
import type { Gadget } from "../gadgets/types.js";
import type { Filedata } from "../../types/index.js";
import type { EncryptionService } from "./index.js";
import { EvmContractAcc } from "@lit-protocol/access-control-conditions";

export class LitEncryptionService implements EncryptionService {
	constructor(
		private readonly litClient: LitClient,
		private readonly chainName: string,
	) { }

	static async init(chain: string): Promise<LitEncryptionService> {
		const litClient = await createLitClient({ network: nagaDev });
		return new LitEncryptionService(litClient, chain);
	}

	async encrypt(file: Filedata, gadget: Gadget): Promise<EncryptedPayload> {
		const { encryptedData, keyMaterial } = await encryptData(file.data);
		const acc = gadget.toAccessCondition();
		// the evmContract condition object
		const rawAcc = acc[0] as EvmContractAcc;

		const litEncryptedKey = await this.litClient.encrypt({
			dataToEncrypt: keyMaterial.toString(),
			evmContractConditions: [rawAcc],
			chain: this.chainName,
		});

		return {
			data: encryptedData,
			key: {
				ciphertext: litEncryptedKey.ciphertext,
				dataToEncryptHash: litEncryptedKey.dataToEncryptHash,
			},
			acc: [rawAcc],
		};
	}

	async decrypt(
		payload: EncryptedPayload,
		authContext: AuthContextWrapper,
	): Promise<DecryptedPayload> {
		console.log("authSig address:", authContext.authSig.address);

		const result = await this.litClient.decrypt({
			data: {
				ciphertext: payload.key.ciphertext,
				dataToEncryptHash: payload.key.dataToEncryptHash,
			},
			unifiedAccessControlConditions: payload.acc,
			authContext: authContext.sessionContext,
			chain: this.chainName,
		});

		const decryptedString = new TextDecoder().decode(result.decryptedData);
		const key = new Uint8Array(decryptedString.split(",").map(n => parseInt(n.trim(), 10)));
		const data = await decryptData(payload.data, key);
		return { data };
	}

	async createAuthContext(
		walletClient: WalletClient,
		domain: string,
	): Promise<AuthContextWrapper> {
		const isNode = typeof window === "undefined";
		const account = isNode ? walletClient.account : walletClient;

		if (!account) throw new Error("No account found in wallet client");
		if (!walletClient.chain) throw new Error("No chain found in wallet client");

		const authManager = isNode
			? createAuthManager({
				storage: storagePlugins.localStorageNode({
					appName: "fangorn",
					networkName: "naga-dev",
					storagePath: "./lit-auth-storage",
				}),
			})
			: createAuthManager({
				storage: storagePlugins.localStorage({
					appName: "fangorn",
					networkName: "naga-dev",
				}),
			});

		const sessionContext = await authManager.createEoaAuthContext({
			litClient: this.litClient,
			config: { account },
			authConfig: {
				domain,
				statement: "Recover key.",
				expiration: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(),
				resources: [
					["access-control-condition-decryption", "*"],
					["lit-action-execution", "*"],
					["pkp-signing", "*"],
				],
			},
		});

		const authSig = await this.createAuthSig(walletClient, domain);

		return { authSig, sessionContext, chainName: walletClient.chain.name };
	}

	private async createAuthSig(
		walletClient: WalletClient,
		domain: string,
	): Promise<AuthSig> {
		const account = walletClient.account;
		if (!account) throw new Error("No account found in wallet client");

		const resources = [
			{
				resource: new LitAccessControlConditionResource("*"),
				ability: "access-control-condition-decryption" as const,
			},
			{
				resource: new LitActionResource("*"),
				ability: "lit-action-execution" as const,
			},
			{
				resource: new LitPKPResource("*"),
				ability: "pkp-signing" as const,
			},
		];

		const siweMessage = await createSiweMessage({
			walletAddress: account.address,
			domain,
			statement: "Decrypt data.",
			uri: `https://${domain}`,
			version: "1",
			chainId: 1,
			expiration: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(),
			resources,
			nonce: Date.now().toString(),
		});

		const signature = await walletClient.signMessage({
			message: siweMessage,
			account,
		});

		return {
			sig: signature,
			derivedVia: "web3.eth.personal.sign",
			signedMessage: siweMessage,
			address: account.address,
		};
	}

	private parseKeyResponse(response: string): Uint8Array {
		return Uint8Array.from(
			response.replace(/^[^\d]+/, "").split(","),
			(entry) => {
				const val = parseInt(entry.trim(), 10);
				return isNaN(val) ? 0 : val;
			},
		);
	}
}