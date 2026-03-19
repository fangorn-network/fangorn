import { WalletClient, type Address, type Hex } from "viem";
import { type Identity } from "@semaphore-protocol/identity";
import { RegisterParams, SettleParams } from "../../registries/settlement-registry";
import { AuthContext } from "../../modules/encryption";
import { ManifestEntry } from "../publisher/types";

export interface PurchaseParams {
	owner: Address;
	schemaId: Hex;
	tag: string;
	identity: Identity;
	payment: Omit<RegisterParams, "resourceId">;
}
 
export interface ClaimParams {
	owner: Address;
	schemaId: Hex;
	tag: string;
	proof: Omit<SettleParams, "resourceId">;
}
 
export interface DecryptParams {
	owner: Address;
	walletClient: WalletClient;
	schemaId: Hex;
	nullifierHash: bigint;
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
}
 
export interface AccessParams {
	owner: Address;
	schemaId: Hex;
	tag: string;
	/** The encrypted field to decrypt after settling */
	field: string;
	identity: Identity;
	payment: Omit<RegisterParams, "resourceId">;
	proof: Omit<SettleParams, "resourceId">;
	authContext?: AuthContext;
}

export interface PurchaseResult {
    txHash: Hex;
    resourceId: Hex;
}

export interface ClaimResult {
    txHash: Hex;
	nullifier: bigint,
    resourceId: Hex;
}

export interface AccessResult {
    data: Uint8Array;
    resourceId: Hex;
    entry: ManifestEntry;
}