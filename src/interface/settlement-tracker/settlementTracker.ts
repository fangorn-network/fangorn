import {
	type PublicClient,
	type WalletClient,
	type Address,
	type Hash,
	Hex,
} from "viem";
import { SETTLEMENT_TRACKER_ABI } from "./abi.js";

export class SettlementTracker {
	private publicClient: PublicClient;
	private walletClient: WalletClient;
	private contractAddress: Address;

	constructor(
		contractAddress: Address,
		publicClient: PublicClient,
		walletClient: WalletClient,
	) {
		this.publicClient = publicClient;
		this.contractAddress = contractAddress;
		this.walletClient = walletClient;
	}

	private getWriteConfig() {
		if (!this.walletClient.chain) throw new Error("Chain required");
		if (!this.walletClient.account) throw new Error("Account required");
		return {
			chain: this.walletClient.chain,
			account: this.walletClient.account,
		};
	}

	getContractAddress() {
		return this.contractAddress;
	}

	async checkSettlement(commitment: Hex, user: Address): Promise<boolean> {
		const result = await this.publicClient.readContract({
			address: this.contractAddress as Hex,
			abi: SETTLEMENT_TRACKER_ABI,
			functionName: "checkSettlement",
			args: [commitment, user],
		} as any);
		return result as boolean;
	}

	/**
	 * Settles the payment on-chain using the EIP-3009 authorization
	 * This is usually called by the Facilitator.
	 */
	async pay(args: {
		commitment: Hex;
		from: Address;
		to: Address;
		value: bigint;
		validAfter: bigint;
		validBefore: bigint;
		nonce: Hex;
		v: number;
		r: Hex;
		s: Hex;
	}): Promise<Hash> {
		const { chain, account } = this.getWriteConfig();

		return this.walletClient.writeContract({
			address: this.contractAddress,
			abi: SETTLEMENT_TRACKER_ABI,
			functionName: "pay",
			args: [
				args.commitment,
				args.from,
				args.to,
				args.value,
				args.validAfter,
				args.validBefore,
				args.nonce,
				args.v,
				args.r,
				args.s,
			],
			chain,
			account,
		});
	}

	async waitForTransaction(hash: Hash) {
		return this.publicClient.waitForTransactionReceipt({ hash });
	}
}
