import { WalletClient, type Address, type Hex } from "viem";
import { ManifestEntry } from "../publisher/types";
import { PrepareSettleResult, TransferWithAuthPayload } from "../../registries/settlement-registry/types";

export interface PurchaseParams {
    owner: Address;
    schemaId: Hex;
    name: string;
    identityCommitment: bigint;
    relayerPrivateKey: Hex;
    preparedRegister: TransferWithAuthPayload;
}

export interface ClaimParams {
    owner: Address;
    schemaId: Hex;
    name: string;
    relayerPrivateKey: Hex;
    preparedSettle: PrepareSettleResult;
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

export interface FetchParams {
    nullifier: string
    resourceId: Hex
    objectKey: string
    walletClient: WalletClient
}

export interface FetchResult {
    data: Uint8Array
    contentType: string
}