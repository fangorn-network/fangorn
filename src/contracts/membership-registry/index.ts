import {
	encodeAbiParameters,
	keccak256,
	type Abi,
	type Address,
	type Hash,
	type Hex,
	type PublicClient,
	type WalletClient,
} from "viem";

import { MEMBERSHIP_REGISTRY_ABI } from "./abi.js";
import { requireWallet, sendWrite } from "../write.js";

/** A signed ERC-3009 `receiveWithAuthorization` paying the registry, as `join` takes it. */
export interface MembershipPayment {
	from: Address;
	value: bigint;
	validAfter: bigint;
	validBefore: bigint;
	nonce: Hex;
	v: number;
	r: Hex;
	s: Hex;
}

/** What `join` needs besides the payment: the app, the commitment, the salt in the nonce. */
export interface JoinArgs {
	appId: Hex;
	commitment: bigint;
	salt: Hex;
	payment: MembershipPayment;
}

/** What `claim` needs: a Semaphore proof over the (app, epoch) group, message = holder. */
export interface ClaimArgs {
	appId: Hex;
	epoch: bigint;
	holder: Address;
	merkleTreeDepth: bigint;
	merkleTreeRoot: bigint;
	nullifier: bigint;
	points: readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
}

/** The nonce a payer signs for `join`, the same derivation as the contract's `joinNonce`. */
export const joinNonce = (appId: Hex, epoch: bigint, commitment: bigint, salt: Hex): Hex =>
	keccak256(
		encodeAbiParameters(
			[{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }],
			[appId, epoch, commitment, salt],
		),
	);

/** The Semaphore scope of (app, epoch), as the contract fixes it in `claim`. */
export const membershipScope = (appId: Hex, epoch: bigint): bigint =>
	BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [appId, epoch])));

/** A holder's membership token id in an app. */
export const membershipTokenId = (appId: Hex, holder: Address): bigint =>
	BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "address" }], [appId, holder])));

/**
 * Client for the MembershipRegistry.
 *
 * The app owner's half is here (`setPlan`), with the reads every gate needs
 * (`canRead`, `planOf`, `currentEpoch`) and the two relayed writes (`join`, `claim`),
 * which take what a buyer signed and proved, so anyone may submit them; Barliman does.
 *
 * The buyer's half (Semaphore identity, stealth holder, the payment signature, the
 * group from `Joined` logs, the proof) lives in `@fangorn-network/fetch`: this SDK
 * carries no Semaphore proving dependency.
 */
export class MembershipRegistryClient {
	constructor(
		private contractAddress: Address,
		private publicClient: PublicClient,
		private walletClient?: WalletClient,
	) {}

	getAddress(): Address {
		return this.contractAddress;
	}

	private write(functionName: string, args: readonly unknown[]): Promise<Hash> {
		return sendWrite(
			this.publicClient,
			requireWallet(this.walletClient, functionName),
			this.contractAddress,
			MEMBERSHIP_REGISTRY_ABI as unknown as Abi,
			functionName,
			args,
		);
	}

	private read<T>(functionName: string, args: readonly unknown[] = []): Promise<T> {
		return this.publicClient.readContract({
			address: this.contractAddress,
			abi: MEMBERSHIP_REGISTRY_ABI as unknown as Abi,
			functionName,
			args,
		}) as Promise<T>;
	}

	/** Price (USDC base units) and period (seconds) of a membership in `appId`. App owner only. */
	setPlan(appId: Hex, price: bigint, period: bigint): Promise<Hash> {
		return this.write("setPlan", [appId, price, period]);
	}

	join({ appId, commitment, salt, payment }: JoinArgs): Promise<Hash> {
		return this.write("join", [appId, commitment, salt, payment]);
	}

	claim(a: ClaimArgs): Promise<Hash> {
		return this.write("claim", [a.appId, a.epoch, a.holder, a.merkleTreeDepth, a.merkleTreeRoot, a.nullifier, a.points]);
	}

	async planOf(appId: Hex): Promise<{ price: bigint; period: bigint }> {
		const [price, period] = await this.read<[bigint, bigint]>("planOf", [appId]);
		return { price, period };
	}

	currentEpoch(appId: Hex): Promise<bigint> {
		return this.read("currentEpoch", [appId]);
	}

	/** What `who` may read with `tokenId`: the app, and until when (seconds; 0 = nothing). */
	async canRead(tokenId: bigint, who: Address): Promise<{ appId: Hex; until: bigint }> {
		const [appId, until] = await this.read<[Hex, bigint]>("canRead", [tokenId, who]);
		return { appId, until };
	}

	expiresAt(tokenId: bigint): Promise<bigint> {
		return this.read("expiresAt", [tokenId]);
	}
}
