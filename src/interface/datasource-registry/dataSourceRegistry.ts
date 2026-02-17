import {
	type PublicClient,
	type WalletClient,
	type Address,
	type Hash,
	parseEventLogs,
	Hex,
} from "viem";
import { DS_REGISTRY_ABI } from "./abi.js";

export interface Vault {
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

	async getDataSource(owner: Address, name: string): Promise<Vault> {
		const result = await (this.publicClient.readContract as any)({
			address: this.contractAddress,
			abi: DS_REGISTRY_ABI,
			functionName: "getDataSource",
			args: [owner, name],
		});

		const manifestCid = result;
		return { manifestCid, owner, name };
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

		console.error("Something went wrong: no id created!");
	}

	async updateDataSource(name: string, newManifestCid: string): Promise<Hash> {
		const { chain, account } = this.getWriteConfig();

		const hash = await this.walletClient.writeContract({
			address: this.contractAddress,
			abi: DS_REGISTRY_ABI,
			functionName: "updateDataSource",
			args: [name, newManifestCid],
			chain,
			account,
		});

		await this.waitForTransaction(hash);

		return hash;
	}

	async waitForTransaction(hash: Hash) {
		return this.publicClient.waitForTransactionReceipt({ hash });
	}
}
