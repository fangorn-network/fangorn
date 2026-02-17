import { WalletClient } from "viem";
import { Filedata } from "../../types";
import { Predicate } from "../predicates";
import { EncryptedPayload, DecryptedPayload } from "./types.js";

export interface EncryptionService {
	encrypt(file: Filedata, predicate: Predicate): Promise<EncryptedPayload>;
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
