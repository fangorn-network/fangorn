import {
    type PublicClient,
    type WalletClient,
    type Address,
    type Hash,
    parseEventLogs,
    Hex,
} from "viem";
import { DS_REGISTRY_ABI } from "./abi.js";

export interface DataSource {
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

    /// Returns the manifest CID + reconstructed DataSource for the given owner+name
    async getDataSource(owner: Address, name: string): Promise<DataSource> {
        const manifestCid = await this.publicClient.readContract({
            address: this.contractAddress,
            abi: DS_REGISTRY_ABI,
            functionName: "getDataSource",
            args: [owner, name],
        } as any) as string;

        return { manifestCid, owner, name };
    }

    /// Returns the list of datasource names owned by the given address
    async getOwnedDataSources(address: Address): Promise<string[]> {
        const result = await this.publicClient.readContract({
            address: this.contractAddress,
            abi: DS_REGISTRY_ABI,
            functionName: "getOwnedDataSources",
            args: [address],
        } as any);
        return result as string[];
    }

    /// Registers a new datasource and returns its bytes32 id
    async registerDataSource(name: string, agentId: string): Promise<Hex> {
        const { chain, account } = this.getWriteConfig();
        const hash = await this.walletClient.writeContract({
            address: this.contractAddress,
            abi: DS_REGISTRY_ABI,
            functionName: "registerDataSource",
            args: [name, agentId],
            chain,
            account,
        });

        const receipt = await this.waitForTransaction(hash);
        const logs = parseEventLogs({ abi: DS_REGISTRY_ABI, logs: receipt.logs });

        const created = logs.find((log) => log.eventName === "DataSourceCreated");
        if (!created) {
            throw new Error("registerDataSource: DataSourceCreated event not found in receipt");
        }

        return (created.args as { id: Hex }).id;
    }

    /// Updates the manifest CID for an existing datasource
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