import { WalletClient } from "viem";
import { Filedata } from "../../types";
import { Gadget } from "../gadgets";
import { EncryptedPayload, DecryptedPayload } from "./types.js";

export * from "./lit.js";

export interface EncryptionService {
	encrypt(file: Filedata, gadget: Gadget): Promise<EncryptedPayload>;
	decrypt(
		payload: EncryptedPayload,
		authContext: AuthContext,
		// privateInputs?
	): Promise<DecryptedPayload>;
	createAuthContext(
		walletClient: WalletClient,
		domain: string,
	): Promise<AuthContext>;
}

/**
 * Auth context needed for Lit decryption
 */
export interface AuthContext {
	authSig: AuthSig;
	sessionContext?: unknown; // Lit's session stuff
}

export interface AuthSig {
	sig: string;
	derivedVia: string;
	signedMessage: string;
	address: string;
}
