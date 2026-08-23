import {
	ContractFunctionArgs,
	ContractFunctionName,
	concat,
	keccak256,
	type Abi,
	type Address,
	type Hash,
	type Hex,
	type PublicClient,
	type WalletClient,
} from "viem";

import { SETTLEMENT_REGISTRY_ABI } from "./abi.js";
import { requireWallet, sendWrite } from "../write.js";

/**
 * `keccak256(publisher ++ uid)` — the same derivation the registry does in
 * `resource_id_of`, and the same one `resourceIdOf` in `@fangorn-network/fetch`
 * does on the buyer side. Pinned against the deployed contract by an e2e case.
 *
 * The id is derived rather than chosen, so a uid cannot be squatted or
 * front-run. Deriving it locally means a publisher knows the id before
 * `createResource` lands, and a buyer needs no RPC to name what they are buying;
 * `resourceIdFor` asks the chain the same question and exists for parity checks.
 */
export const resourceIdOf = (publisher: Address, uid: Hex): Hex =>
	keccak256(concat([publisher, uid]));

/**
 * The on-chain `uri` is not free-form: it packs the access worker to fetch from
 * and the sha256 of the plaintext to verify against, as `${workerUrl}#${hash}`.
 *
 * The hash is what makes a read more than a download — without it a worker can
 * serve any bytes that happen to decrypt. `unpackUri` in `@fangorn-network/fetch`
 * is the other side of this, and a publisher who lists a bare URL produces a
 * resource that buyer cannot verify.
 */
export const packResourceUri = (workerUrl: string, plaintextHash: Hex): string =>
	`${workerUrl.replace(/\/$/, "")}#${plaintextHash}`;

/** Everything the registry knows about a priced resource. */
export interface Resource {
	owner: Address;
	/** In the settlement token's smallest unit. Zero means free. */
	price: bigint;
	/** The Semaphore group minted for this resource when it was created. */
	groupId: bigint;
	uri: string;
	disabled: boolean;
}

/**
 * An EIP-3009 `transferWithAuthorization` signature: what lets a consumer pay in
 * USDC without ever holding gas, because someone else relays it for them.
 */
export interface TransferAuthorization {
	from: Address;
	amount: bigint;
	validAfter: bigint;
	validBefore: bigint;
	nonce: Hex;
	v: number;
	r: Hex;
	s: Hex;
}

/** A Semaphore membership proof, as the contract wants it. */
export interface SemaphoreProof {
	merkleTreeDepth: bigint;
	merkleTreeRoot: bigint;
	nullifier: bigint;
	message: bigint;
	/** The eight field elements of the Groth16 proof. */
	points: readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
}

/**
 * Client for the SettlementRegistry — the pay-then-read rail.
 *
 * The two consumer calls are separate on purpose, and the separation is the whole
 * privacy property:
 *
 * 1. `register` — pay for `resourceId` and join its Semaphore group with an
 *    identity commitment. This transaction is linked to the payer.
 * 2. `settle` — prove group membership in zero knowledge from a *fresh stealth
 *    address*, which is then the address `isSettled` answers for.
 *
 * Nothing on-chain connects the payer to the reader beyond membership of the same
 * group, so a publisher can verify a reader paid without learning who they are.
 * Both are normally relayed by a facilitator, so the consumer needs no gas at all —
 * which is why `register` takes a signed authorization rather than moving funds
 * from `msg.sender`.
 *
 * Constructing without a wallet client gives a read-only client: that is the access
 * worker's usage, which only ever asks `isSettled` and `getPrice`.
 *
 * The publisher half of the flow is here. The BUYER half — deriving a Semaphore
 * identity, signing the EIP-3009 authorization, rebuilding the resource's group
 * from `MemberRegistered` logs and proving membership — already lives in
 * `@fangorn-network/fetch` (x402f), which relays both writes through a facilitator
 * so the buyer never needs gas. Do not reimplement it here: this SDK deliberately
 * carries no Semaphore proving dependency (see the note in the wiki's gotchas).
 */
export class SettlementRegistryClient {
	constructor(
		private contractAddress: Address,
		private publicClient: PublicClient,
		private walletClient?: WalletClient,
	) {}

	getAddress(): Address {
		return this.contractAddress;
	}

	private executeWrite<
		TFunctionName extends ContractFunctionName<
			typeof SETTLEMENT_REGISTRY_ABI,
			"payable" | "nonpayable"
		>,
	>(
		functionName: TFunctionName,
		args: ContractFunctionArgs<
			typeof SETTLEMENT_REGISTRY_ABI,
			"payable" | "nonpayable",
			TFunctionName
		>,
	): Promise<Hash> {
		return sendWrite(
			this.publicClient,
			requireWallet(this.walletClient, functionName),
			this.contractAddress,
			SETTLEMENT_REGISTRY_ABI as unknown as Abi,
			functionName,
			args as readonly unknown[],
		);
	}

	// ── Publisher writes ─────────────────────────────────────────────────────

	/**
	 * List a resource for sale and mint its Semaphore group in one transaction.
	 *
	 * `uid` is the publisher's own identifier for the item; the on-chain
	 * `resourceId` is `resourceIdFor(owner, uid)`, so two publishers can use the
	 * same uid without collision and a publisher can compute the id before the
	 * transaction lands. Claiming the same uid twice reverts `AlreadyRegistered`.
	 */
	async createResource(uid: Hex, price: bigint, uri: string): Promise<Hash> {
		return this.executeWrite("createResource", [uid, price, uri]);
	}

	/** Reprice a resource. Does not affect anyone who already settled. */
	async updatePrice(resourceId: Hex, price: bigint): Promise<Hash> {
		return this.executeWrite("updatePrice", [resourceId, price]);
	}

	/**
	 * Take a resource off the market. Existing settlements still read — disabling
	 * blocks new registrations, it does not revoke access that was paid for.
	 */
	async setDisabled(resourceId: Hex, disabled: boolean): Promise<Hash> {
		return this.executeWrite("setDisabled", [resourceId, disabled]);
	}

	/**
	 * Attach a contract called after each successful `settle`.
	 *
	 * No funds pass through it and it cannot change the payment: it fires after
	 * settlement is already recorded, and a revert inside it surfaces as
	 * `HookFailed`. It is a notification, not a fee lever.
	 */
	async registerHook(resourceId: Hex, hook: Address): Promise<Hash> {
		return this.executeWrite("registerHook", [resourceId, hook]);
	}

	// ── Consumer writes ──────────────────────────────────────────────────────

	/**
	 * Step 1: pay for `resourceId` and join its group.
	 *
	 * The USDC moves via the caller's EIP-3009 authorization, not from
	 * `msg.sender`, so this is safe (and intended) to relay. `amount` must equal
	 * the current price exactly, or it reverts `IncorrectPaymentAmount` — quote
	 * `getPrice` immediately before signing, since the owner can reprice.
	 */
	async register(
		resourceId: Hex,
		identityCommitment: bigint,
		auth: TransferAuthorization,
	): Promise<Hash> {
		return this.executeWrite("register", [
			resourceId,
			identityCommitment,
			auth.from,
			auth.amount,
			auth.validAfter,
			auth.validBefore,
			auth.nonce,
			auth.v,
			auth.r,
			auth.s,
		]);
	}

	/**
	 * Step 2: prove membership from `stealthAddress`, which is the address
	 * `isSettled` will answer for afterwards.
	 *
	 * The proof's nullifier makes this once-per-identity: a second settle reverts
	 * `AlreadySettled`. Send it from an address with no history, or the
	 * unlinkability that `register`/`settle` exist to provide is spent for nothing.
	 *
	 * `hookData` is `uint8[]`, not `bytes` — the contract declares it `Vec<u8>`, and
	 * Stylus maps that to a dynamic array of words. Every byte costs a full 32-byte
	 * slot in calldata, so keep it empty unless a hook actually reads it.
	 */
	async settle(
		resourceId: Hex,
		stealthAddress: Address,
		proof: SemaphoreProof,
		hookData: readonly number[] = [],
	): Promise<Hash> {
		return this.executeWrite("settle", [
			resourceId,
			stealthAddress,
			proof.merkleTreeDepth,
			proof.merkleTreeRoot,
			proof.nullifier,
			proof.message,
			proof.points,
			hookData,
		]);
	}

	// ── Views ────────────────────────────────────────────────────────────────

	/** True if `stealthAddress` has settled for `resourceId`. */
	async isSettled(stealthAddress: Address, resourceId: Hex): Promise<boolean> {
		return this.publicClient.readContract({
			address: this.contractAddress,
			abi: SETTLEMENT_REGISTRY_ABI,
			functionName: "isSettled",
			args: [stealthAddress, resourceId],
		});
	}

	/** Price of `resourceId` in the settlement token's smallest unit; 0 = free. */
	async getPrice(resourceId: Hex): Promise<bigint> {
		return this.publicClient.readContract({
			address: this.contractAddress,
			abi: SETTLEMENT_REGISTRY_ABI,
			functionName: "getPrice",
			args: [resourceId],
		});
	}

	/** The id a `uid` will get under `publisher` — computable before listing. */
	async resourceIdFor(publisher: Address, uid: Hex): Promise<Hex> {
		return this.publicClient.readContract({
			address: this.contractAddress,
			abi: SETTLEMENT_REGISTRY_ABI,
			functionName: "resourceIdFor",
			args: [publisher, uid],
		});
	}

	/** Whether this identity commitment already joined the resource's group. */
	async isRegistered(resourceId: Hex, identityCommitment: bigint): Promise<boolean> {
		return this.publicClient.readContract({
			address: this.contractAddress,
			abi: SETTLEMENT_REGISTRY_ABI,
			functionName: "isRegistered",
			args: [resourceId, identityCommitment],
		});
	}

	async getOwner(resourceId: Hex): Promise<Address> {
		return this.publicClient.readContract({
			address: this.contractAddress,
			abi: SETTLEMENT_REGISTRY_ABI,
			functionName: "getOwner",
			args: [resourceId],
		});
	}

	async getGroupId(resourceId: Hex): Promise<bigint> {
		return this.publicClient.readContract({
			address: this.contractAddress,
			abi: SETTLEMENT_REGISTRY_ABI,
			functionName: "getGroupId",
			args: [resourceId],
		});
	}

	async getUri(resourceId: Hex): Promise<string> {
		return this.publicClient.readContract({
			address: this.contractAddress,
			abi: SETTLEMENT_REGISTRY_ABI,
			functionName: "getUri",
			args: [resourceId],
		});
	}

	async isDisabled(resourceId: Hex): Promise<boolean> {
		return this.publicClient.readContract({
			address: this.contractAddress,
			abi: SETTLEMENT_REGISTRY_ABI,
			functionName: "isDisabled",
			args: [resourceId],
		});
	}

	/**
	 * Everything a listing page needs, in one round trip. An unlisted resource
	 * comes back with a zero owner rather than throwing — `getPrice` alone cannot
	 * tell "free" from "does not exist".
	 */
	async getResource(resourceId: Hex): Promise<Resource> {
		const [owner, price, groupId, uri, disabled] = await Promise.all([
			this.getOwner(resourceId),
			this.getPrice(resourceId),
			this.getGroupId(resourceId),
			this.getUri(resourceId),
			this.isDisabled(resourceId),
		]);
		return { owner, price, groupId, uri, disabled };
	}

	async getUsdc(): Promise<Address> {
		return this.publicClient.readContract({
			address: this.contractAddress,
			abi: SETTLEMENT_REGISTRY_ABI,
			functionName: "getUsdc",
		});
	}

	async getSemaphore(): Promise<Address> {
		return this.publicClient.readContract({
			address: this.contractAddress,
			abi: SETTLEMENT_REGISTRY_ABI,
			functionName: "getSemaphore",
		});
	}

	async getAdmin(): Promise<Address> {
		return this.publicClient.readContract({
			address: this.contractAddress,
			abi: SETTLEMENT_REGISTRY_ABI,
			functionName: "getAdmin",
		});
	}

	async setAdmin(admin: Address): Promise<Hash> {
		return this.executeWrite("setAdmin", [admin]);
	}
}
