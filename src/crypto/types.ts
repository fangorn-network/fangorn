export interface AesEncryptedData {
	ciphertext: Uint8Array<ArrayBuffer>;
	iv: Uint8Array<ArrayBuffer>;
	authTag: Uint8Array<ArrayBuffer>;
	salt: Uint8Array<ArrayBuffer>;
}
 
export interface DecryptedPayload {
	data: Uint8Array;
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
