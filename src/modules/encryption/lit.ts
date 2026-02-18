import { createSiweMessage } from "@lit-protocol/auth-helpers";
import {
	LitAccessControlConditionResource,
	LitActionResource,
	LitPKPResource,
} from "@lit-protocol/auth-helpers";
import { LitClient } from "@lit-protocol/lit-client";
import { createAuthManager, storagePlugins } from "@lit-protocol/auth";
import { WalletClient } from "viem";

import { encryptData, decryptData } from "./aes.js";
import type {
	EncryptedPayload,
	DecryptedPayload,
	AuthContextWrapper,
	AuthSig,
} from "./types.js";
import type { Predicate } from "../predicates/types.js";
import type { Filedata } from "../../types/index.js";
import { EncryptionService } from "./index.js";

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
		private config: LitEncryptionServiceConfig,
	) {}

	async encrypt(
		file: Filedata,
		predicate: Predicate,
	): Promise<EncryptedPayload> {
		// local AES encryption
		const { encryptedData, keyMaterial } = await encryptData(file.data);

		// get ACC from predicate
		const acc = await predicate.toAccessCondition();

		// encrypt key with Lit
		const litEncryptedKey = await this.litClient.encrypt({
			dataToEncrypt: keyMaterial.toString(),
			unifiedAccessControlConditions: acc,
			chain: this.config.chainName,
		});

		return {
			data: encryptedData,
			key: {
				ciphertext: litEncryptedKey.ciphertext,
				dataToEncryptHash: litEncryptedKey.dataToEncryptHash,
			},
			acc,
			litAction: predicate.toLitAction(),
		};
	}

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

		console.log("decrypt result " + JSON.stringify(result));

		// TODO: error handling
		// parse key from response
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
		const account = walletClient.account!;

		// Create session context
		const authManager = createAuthManager({
			storage: storagePlugins.localStorageNode({
				appName: "fangorn",
				networkName: "naga-dev",
				storagePath: "./lit-auth-storage",
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
