import { createSiweMessage } from "@lit-protocol/auth-helpers";
import {
	LitAccessControlConditionResource,
	LitActionResource,
	LitPKPResource,
} from "@lit-protocol/auth-helpers";
import { createLitClient, LitClient } from "@lit-protocol/lit-client";
import { createAuthManager, storagePlugins } from "@lit-protocol/auth";
import { WalletClient } from "viem";

import { encryptData, decryptData } from "./aes.js";
import type {
	EncryptedPayload,
	DecryptedPayload,
	AuthContextWrapper,
	AuthSig,
} from "./types.js";
import type { Gadget } from "../gadgets/types.js";
import type { Filedata } from "../../types/index.js";
import { EncryptionService } from "./index.js";
import { nagaDev } from "@lit-protocol/networks";

const createDecryptLitActionCode = (chainName: string) => `(async () => {
    try {
        const decryptedContent = await Lit.Actions.decryptAndCombine({
            accessControlConditions: jsParams.accessControlConditions,
            ciphertext: jsParams.ciphertext,
            dataToEncryptHash: jsParams.dataToEncryptHash,
            authSig: jsParams.authSig,
            chain: "${chainName}",
        });
        Lit.Actions.setResponse({
            response: decryptedContent,
            success: true,
        });
    } catch (error) {
        Lit.Actions.setResponse({
            response: error.message,
            success: false,
        });
    }
})();`;

export interface LitEncryptionServiceConfig {
	chainName: string;
}

export class LitEncryptionService implements EncryptionService {
	constructor(
		private litClient: LitClient,
		private chainName: string,
	) {}

	public static async init(chain: string): Promise<LitEncryptionService> {
		const litclient = await createLitClient({ network: nagaDev });
		return new LitEncryptionService(litclient, chain);
	}

	/**
	 * Encrypt filedata under the given gadget
	 * @param file The filedata to encrypt
	 * @param gadget The gadget to use
	 * @returns The ciphertext bundle
	 */
	async encrypt(file: Filedata, gadget: Gadget): Promise<EncryptedPayload> {
		// local AES encryption
		const { encryptedData, keyMaterial } = await encryptData(file.data);
		// get ACC from gadget
		const acc = await gadget.toAccessCondition();
		// encrypt key with Lit
		const litEncryptedKey = await this.litClient.encrypt({
			dataToEncrypt: keyMaterial.toString(),
			unifiedAccessControlConditions: acc,
			chain: this.chainName,
		});

		return {
			data: encryptedData,
			key: {
				ciphertext: litEncryptedKey.ciphertext,
				dataToEncryptHash: litEncryptedKey.dataToEncryptHash,
			},
			acc,
			litAction: gadget.toLitAction(),
		};
	}

	/**
	 * Attempt to decrypt some encrypted data
	 * @param payload The encrytped bundle to recover
	 * @param authContext The authorization context
	 * @returns The decrytped output (on success), else empty
	 */
	async decrypt(
		payload: EncryptedPayload,
		authContext: AuthContextWrapper,
	): Promise<DecryptedPayload> {
		// execute Lit action to recover key
		const result = await this.litClient.executeJs({
			code: createDecryptLitActionCode(authContext.chainName),
			authContext: authContext.sessionContext,
			jsParams: {
				accessControlConditions: payload.acc,
				ciphertext: payload.key.ciphertext,
				dataToEncryptHash: payload.key.dataToEncryptHash,
				authSig: authContext.authSig,
			},
		});

		// TODO: error handling
		const key = this.parseKeyResponse(
			result.response as string,
		) as Uint8Array<ArrayBuffer>;

		// local AES decryption
		const data = await decryptData(payload.data, key);

		return { data };
	}

	async createAuthContext(
		walletClient: WalletClient,
		domain: string,
	): Promise<AuthContextWrapper> {
		const isWindowUndefined = typeof window === "undefined";
		const account = isWindowUndefined ? walletClient.account : walletClient;
		// load the auth context
		const authManager = isWindowUndefined
			? // node.js support
				createAuthManager({
					storage: storagePlugins.localStorageNode({
						appName: "fangorn",
						networkName: "naga-dev",
						storagePath: "./lit-auth-storage",
					}),
				})
			: // browser support
				createAuthManager({
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

		// Create direct auth sig
		const authSig = await this.createAuthSig(walletClient, domain);

		return { authSig, sessionContext, chainName: walletClient.chain.name };
	}

	private async createAuthSig(
		walletClient: WalletClient,
		domain: string,
	): Promise<AuthSig> {
		const account = walletClient.account!;

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
			statement: "Decrypt data",
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

	// parse the aes key from the response string
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
