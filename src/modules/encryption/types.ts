import { UnifiedAccessControlCondition } from "@lit-protocol/access-control-conditions";

export interface AesEncryptedData {
	ciphertext: Uint8Array<ArrayBuffer>;
	iv: Uint8Array<ArrayBuffer>;
	authTag: Uint8Array<ArrayBuffer>;
	salt: Uint8Array<ArrayBuffer>;
}

export interface LitEncryptedData {
	ciphertext: string;
	dataToEncryptHash: string;
}

/**
 * Complete encrypted payload - stored to IPFS
 */
export interface EncryptedPayload {
	data: AesEncryptedData;
	key: LitEncryptedData;
	acc: UnifiedAccessControlCondition;
	litAction: string;
}

/**
 * Lit's access control condition structure
 * Using a loose type since Lit's ACC shape is complex and varies by condition type
 */
export type AccessControlCondition = Record<string, unknown>;

/**
 * Auth signature for Lit
 */
export interface AuthSig {
	sig: string;
	derivedVia: string;
	signedMessage: string;
	address: string;
}

/**
 * Context needed to authenticate with Lit for decryption
 */
export interface AuthContextWrapper {
	authSig: AuthSig;
	sessionContext: Record<string, unknown>;
	chainName: string;
}

/**
 * Result of successful decryption
 */
export interface DecryptedPayload {
	data: Uint8Array;
	metadata?: {
		tag: string;
		extension?: string;
		fileType?: string;
	};
}
