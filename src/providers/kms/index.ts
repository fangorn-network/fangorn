import { AccessControlConditions } from "@lit-protocol/access-control-conditions";
import { LitKMSProvider } from "./lit";
import { MockKMSProvider } from "./mock";

export interface KMSProvider {
	readonly name: string;
	connect(): Promise<void>;
	disconnect(): Promise<void>;
	isConnected(): boolean;
	// (data, acc) -> ciphertext
	encrypt(params: EncryptParams): Promise<EncryptResult>;
	// (ct, witness) -> message
	decrypt(params: DecryptParams): Promise<DecryptResult>;
	uploadAction?(code: string): Promise<string>;
}

export type KMSProviderType = "lit" | "mock";

export interface KMSProviderConfig {
	type: KMSProviderType;
	//   /** For Lit: network name (e.g., 'naga-dev', 'naga') */
	//   network?: Supported;
	/** For Mock: RPC URL for real contract calls */
	rpcUrl?: string;
	/** For Mock: whether to auto-approve all verifications */
	alwaysVerify?: boolean;
}

/**
 * Create a KMS provider based on configuration
 */
export function createKMSProvider(config: KMSProviderConfig): KMSProvider {
	switch (config.type) {
		case "lit":
			return new LitKMSProvider(config);
		case "mock":
			return new MockKMSProvider(config);
		default:
			throw new Error(`Unknown KMS provider type: ${config.type}`);
	}
}

export interface EncryptParams {
	/** Data to encrypt (string or bytes) */
	data: string | Uint8Array;
	/** Optional access control conditions */
	accessControlConditions?: AccessControlConditions;
	/** Chain for on-chain conditions */
	chain?: string;
}

export interface EncryptResult {
	/** Base64-encoded ciphertext */
	ciphertext: string;
	/** Hash of the original data (used as key identifier) */
	dataHash: string;
}

export interface DecryptParams {
	/** The ciphertext to decrypt */
	ciphertext: string;
	/** Hash of the original data */
	dataHash: string;
	/** Lit Action code (as string or IPFS CID) */
	litActionCode?: string;
	litActionIpfsCid?: string;
	/** Parameters to pass to the Lit Action */
	jsParams?: Record<string, unknown>;
	/** Auth context (wallet address, session, etc.) */
	//   authContext?: AuthConfi;
}

export interface DecryptResult {
	/** Whether decryption succeeded */
	success: boolean;
	/** Decrypted data (if successful) */
	data?: Uint8Array;
	/** Error message (if failed) */
	error?: string;
	/** Execution logs */
	logs?: string[];
}

// export interface AuthContext {
//   /** Wallet address */
//   address?: string;
//   /** Signature-based auth */
//   authSig?: {
//     sig: string;
//     derivedVia: string;
//     signedMessage: string;
//     address: string;
//   };
//   /** Session-based auth (Lit v3+) */
//   sessionSigs?: Record<string, unknown>;
// }
