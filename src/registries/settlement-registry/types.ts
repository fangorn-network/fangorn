import {
    type Address,
    type Hex,
} from "viem";
import { Identity } from "@semaphore-protocol/identity";

// register 
export interface TransferWithAuthParams {
    burnerPrivateKey: Hex;
    paymentRecipient: Address;
    amount: bigint;
    usdcAddress: Address;
    usdcDomainName: string;
    usdcDomainVersion: string;
}

export interface TransferWithAuthPayload {
    burnerAddress: Address;
    paymentRecipient: Address;
    amount: bigint;
    validAfter: bigint;
    validBefore: bigint;
    nonce: Hex;
    v: number;
    r: Hex;
    s: Hex;
}

export interface RegisterParams {
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