import { UnifiedAccessControlCondition } from "@lit-protocol/access-control-conditions";
import { createAuthManager } from "@lit-protocol/auth";

export type EoaAuthContext = Awaited<ReturnType<ReturnType<typeof createAuthManager>["createEoaAuthContext"]>>;

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
export interface EncryptedPayload {
	/** Locally AES-encrypted file bytes */
	data: AesEncryptedData;
	/** Lit-threshold-encrypted AES key */
	key: {
		ciphertext:        string;
		dataToEncryptHash: string;
	};
	/**
	 * The ACC used to encrypt the key — stored here so decrypt() can
	 * reconstruct the exact conditions without re-deriving them from
	 * the gadget. The gadget is a publisher-time concept; the consumer
	 * only has the payload.
	 */
	acc: UnifiedAccessControlCondition[];
}
 
export interface DecryptedPayload {
	data: Uint8Array;
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
	sessionContext: EoaAuthContext;
	chainName: string;
	nullifierHash?: string;
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
