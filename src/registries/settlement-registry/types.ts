import {
    type Address,
    type Hex,
} from "viem";
import { Identity } from "@semaphore-protocol/identity";

export interface RegisterParams {
    resourceId: Hex;
    identity: Identity;
    burnerPrivateKey: Hex;           // holds USDC, signs ERC-3009 — never linked to identity
    paymentRecipient: Address;       // schema owner treasury
    amount: bigint;
    relayerPrivateKey?: Hex;           // who submits the tx (irrelevant to privacy)
    usdcAddress: Address;
    usdcDomainName: string;        // e.g. "USD Coin"
    usdcDomainVersion: string;        // e.g. "2"
}

export interface SettleParams {
    resourceId: Hex;
    identity: Identity;
    stealthAddress: Address;           // EIP-5564 stealth address — receives NFT/timelock
    hookData?: Hex;               // defaults to abi.encode(stealthAddress, "")
    callerKey: Hex;               // any wallet — proof is the auth, not msg.sender
}
