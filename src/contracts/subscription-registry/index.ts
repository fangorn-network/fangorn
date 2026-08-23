import {
	ContractFunctionArgs,
	ContractFunctionName,
	type Abi,
	type Address,
	type Hash,
	type PublicClient,
	type WalletClient,
} from "viem";

import { SUBSCRIPTION_REGISTRY_ABI } from "./abi.js";
import { requireWallet, sendWrite } from "../write.js";

/** What the upload gate needs to decide whether to serve a publisher. */
export interface SubscriptionAccess {
	/** Registered in the DataRegistry. Read here via cross-call, so it is never stale. */
	registered: boolean;
	/** Unix seconds of the last payment, or 0 if they never subscribed. */
	paidAt: bigint;
}

/**
 * Client for the SubscriptionRegistry — the publisher-side storage paywall.
 *
 * Deliberately does NOT decide whether a subscription is currently valid. The
 * contract stores only when it was last paid; the active window and any free tier
 * are the gate's policy, and keeping them off-chain means changing them is a config
 * edit rather than a redeploy. `isActiveAt` is offered as the obvious default, with
 * the window passed in.
 */
export class SubscriptionRegistryClient {
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
			typeof SUBSCRIPTION_REGISTRY_ABI,
			"payable" | "nonpayable"
		>,
	>(
		functionName: TFunctionName,
		args: ContractFunctionArgs<
			typeof SUBSCRIPTION_REGISTRY_ABI,
			"payable" | "nonpayable",
			TFunctionName
		>,
	): Promise<Hash> {
		return sendWrite(
			this.publicClient,
			requireWallet(this.walletClient, functionName),
			this.contractAddress,
			SUBSCRIPTION_REGISTRY_ABI as unknown as Abi,
			functionName,
			args as readonly unknown[],
		);
	}

	// ── Writes ───────────────────────────────────────────────────────────────

	/**
	 * Open or renew this wallet's subscription.
	 *
	 * The fee is pulled in USDC, so the caller must have `approve`d this contract
	 * for at least `subscriptionFee()` first — otherwise the call reverts
	 * `SubscriptionFeeRequired`, which reads like a pricing error but is really an
	 * allowance one. Renewing while still active is allowed and simply re-stamps
	 * the timestamp, so there is no window to lose by renewing early.
	 */
	async subscribe(): Promise<Hash> {
		return this.executeWrite("subscribe", []);
	}

	// ── Views ────────────────────────────────────────────────────────────────

	/** The single oracle the upload gate reads. */
	async access(publisher: Address): Promise<SubscriptionAccess> {
		const [registered, paidAt] = await this.publicClient.readContract({
			address: this.contractAddress,
			abi: SUBSCRIPTION_REGISTRY_ABI,
			functionName: "access",
			args: [publisher],
		});
		return { registered, paidAt };
	}

	/**
	 * Registered, paid, and inside `windowSeconds` of that payment — the whole
	 * gate policy in one call. `now` is injectable so a caller can evaluate against
	 * block time rather than wall-clock skew.
	 */
	async isActiveAt(
		publisher: Address,
		windowSeconds: bigint,
		now = BigInt(Math.floor(Date.now() / 1000)),
	): Promise<boolean> {
		const { registered, paidAt } = await this.access(publisher);
		return registered && paidAt > 0n && now < paidAt + windowSeconds;
	}

	async subscribedAt(publisher: Address): Promise<bigint> {
		return this.publicClient.readContract({
			address: this.contractAddress,
			abi: SUBSCRIPTION_REGISTRY_ABI,
			functionName: "subscribedAt",
			args: [publisher],
		});
	}

	/** The fee in USDC's smallest unit (6 decimals), not wei. */
	async subscriptionFee(): Promise<bigint> {
		return this.publicClient.readContract({
			address: this.contractAddress,
			abi: SUBSCRIPTION_REGISTRY_ABI,
			functionName: "subscriptionFee",
		});
	}

	async usdc(): Promise<Address> {
		return this.publicClient.readContract({
			address: this.contractAddress,
			abi: SUBSCRIPTION_REGISTRY_ABI,
			functionName: "usdc",
		});
	}

	/** The DataRegistry this contract cross-calls for `isRegistered`. */
	async dataRegistry(): Promise<Address> {
		return this.publicClient.readContract({
			address: this.contractAddress,
			abi: SUBSCRIPTION_REGISTRY_ABI,
			functionName: "dataRegistry",
		});
	}

	async admin(): Promise<Address> {
		return this.publicClient.readContract({
			address: this.contractAddress,
			abi: SUBSCRIPTION_REGISTRY_ABI,
			functionName: "admin",
		});
	}

	// ── Admin ────────────────────────────────────────────────────────────────

	async setSubscriptionFee(fee: bigint): Promise<Hash> {
		return this.executeWrite("setSubscriptionFee", [fee]);
	}

	async setUsdc(token: Address): Promise<Hash> {
		return this.executeWrite("setUsdc", [token]);
	}

	async setDataRegistry(registry: Address): Promise<Hash> {
		return this.executeWrite("setDataRegistry", [registry]);
	}

	async withdrawUsdc(to: Address, amount: bigint): Promise<Hash> {
		return this.executeWrite("withdrawUsdc", [to, amount]);
	}

	async withdrawEth(to: Address, amount: bigint): Promise<Hash> {
		return this.executeWrite("withdrawEth", [to, amount]);
	}
}
