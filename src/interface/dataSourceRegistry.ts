import {
	type PublicClient,
	type WalletClient,
	type Address,
	type Hash,
	parseEventLogs,
	Hex,
} from "viem";
import { DS_REGISTRY_ABI } from "./abi";

export interface Vault {
	poseidonRoot: `0x${string}`;
	manifestCid: string;
	owner: Address;
	name: string;
}

export class DataSourceRegistry {
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

	// --- Read Functions ---
	async checkSettlement(commitment: Hex, user: Address): Promise<boolean> {
		const result = await this.publicClient.readContract({
			address: this.contractAddress as Hex,
			abi: DS_REGISTRY_ABI,
			functionName: "checkSettlement",
			args: [commitment, user],
		} as any);
		return result as boolean;
	}

	async getDataSource(vaultId: `0x${string}`): Promise<Vault> {
		const result = await (this.publicClient.readContract as any)({
			address: this.contractAddress,
			abi: DS_REGISTRY_ABI,
			functionName: "getDataSource",
			args: [vaultId],
		});

		const [poseidonRoot, manifestCid, owner, name] = result;
		return { poseidonRoot, manifestCid, owner, name };
	}

	async dataSourceExists(vaultId: `0x${string}`): Promise<boolean> {
		const vault = await this.getDataSource(vaultId);
		return vault.owner !== "0x0000000000000000000000000000000000000000";
	}

	async getOwnedDataSources(address: Address): Promise<Hex[]> {
		const result = await this.publicClient.readContract({
			address: this.contractAddress,
			abi: DS_REGISTRY_ABI,
			functionName: "getOwnedDataSources",
			args: [address],
		} as any);

		return result as Hex[];
	}

	// --- Write Functions ---

	async registerDataSource(name: string): Promise<Hex> {
		const { chain, account } = this.getWriteConfig();

		const hash = await this.walletClient.writeContract({
			address: this.contractAddress,
			abi: DS_REGISTRY_ABI,
			functionName: "registerDataSource",
			args: [name],
			chain,
			account,
		});

		const receipt = await this.waitForTransaction(hash);
		const logs = parseEventLogs({
			abi: DS_REGISTRY_ABI,
			logs: receipt.logs,
		});

		for (const log of logs) {
			if (log.eventName == "DataSourceCreated") {
				// TODO: verify the owner too?
				return log.args.id as Hex;
			}
		}

		console.error("no id!");
	}

	async updateDataSource(
		id: `0x${string}`,
		newRoot: `0x${string}`,
		newManifestCid: string,
	): Promise<Hash> {
		const { chain, account } = this.getWriteConfig();

		const hash = await this.walletClient.writeContract({
			address: this.contractAddress,
			abi: DS_REGISTRY_ABI,
			functionName: "updateDataSource",
			args: [id, newRoot, newManifestCid],
			chain,
			account,
		});

		await this.waitForTransaction(hash);

		return hash;
	}

	// --- Helpers ---

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
			abi: DS_REGISTRY_ABI,
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
