import { WalletClient, type Address, type Hex } from "viem";
import { type Identity } from "@semaphore-protocol/identity";
import { RegisterParams, SettleParams } from "../../registries/settlement-registry";
import { AuthContext } from "../../modules/encryption";
import { VaultEntry } from "../../types";
import { ManifestEntry } from "../publisher/types";

export type PurchaseParams = {
	owner: Address;
	schemaId: Hex;
	tag: string;
	identity: Identity;
	payment: Omit<RegisterParams, "resourceId">;
};
 
export type ClaimParams = {
	owner: Address;
	schemaId: Hex;
	tag: string;
	proof: Omit<SettleParams, "resourceId">;
};
 
export type DecryptParams = {
	owner: Address;
	walletClient: WalletClient;
	schemaId: Hex;
	nullifierHash: BigInt;
	/** The record tag — maps to the resourceId */
	tag: string;
	/** The specific encrypted field within the record to decrypt */
	field: string;
	identity?: Identity;
	/**
	 * When true, skips settlement verification.
	 * Use for owner self-access or out-of-band flows only.
	 */
	skipSettlementCheck?: boolean;
	authContext?: AuthContext;
};
 
export type AccessParams = {
	owner: Address;
	schemaId: Hex;
	tag: string;
	/** The encrypted field to decrypt after settling */
	field: string;
	identity: Identity;
	payment: Omit<RegisterParams, "resourceId">;
	proof: Omit<SettleParams, "resourceId">;
	authContext?: AuthContext;
};

export type PurchaseResult = {
    txHash: Hex;
    resourceId: Hex;
};

export type ClaimResult = {
    txHash: Hex;
	nullifier: BigInt,
    resourceId: Hex;
};

export type AccessResult = {
    data: Uint8Array;
    resourceId: Hex;
    entry: ManifestEntry;
};