import { EncryptedData } from "../types/types.js";
export declare function encryptData(data: string | Uint8Array): Promise<{
	encryptedData: EncryptedData;
	keyMaterial: Uint8Array<ArrayBuffer>;
}>;
export declare function decryptData(
	encryptedData: EncryptedData,
	keyMaterial: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array>;
