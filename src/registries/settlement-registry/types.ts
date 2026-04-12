import {
    WalletClient,
    type Address,
    type Hex,
} from "viem";
import { Identity } from "@semaphore-protocol/identity";

// register 
export interface TransferWithAuthParams {
    walletClient?: WalletClient;
    paymentRecipient: Address;
    amount: bigint;
    usdcAddress: Address;
    usdcDomainName: string;
    usdcDomainVersion: string;
}

export interface TransferWithAuthPayload {
    sender: Address;
    paymentRecipient: Address;
    amount: bigint;
    validAfter: bigint;
    validBefore: bigint;
    nonce: Hex;
    v: number;
    r: Hex;
    s: Hex;
}

/**
 * The params for registering with a semaphore group
 */
export interface RegisterParams {
    // Q: should the address (e.g. burner address) be here?
    resourceId: Hex;
    identityCommitment: bigint;
    relayerPrivateKey: Hex;
    preparedRegister: TransferWithAuthPayload;
}

// settle
export interface PrepareSettleParams {
    resourceId: Hex;
    identity: Identity;
    stealthAddress: Address;
    hookData?: Hex;
}

export interface PrepareSettleResult {
    resourceId: Hex;
    stealthAddress: Address;
    merkleTreeDepth: bigint;
    merkleTreeRoot: bigint;
    nullifier: bigint;
    message: bigint;
    points: [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
    hookData: Hex;
}

export interface SettleParams {
    relayerPrivateKey: Hex;
    preparedSettle: PrepareSettleResult;
}