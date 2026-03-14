import {
    type PublicClient,
    type WalletClient,
    type Address,
    type Hash,
    type Hex,
    parseEventLogs,
} from "viem";
import { DS_REGISTRY_ABI } from "./abi.js";

export interface DataSource {
    manifestCid: string;
    schemaId: Hex;
    version: bigint;
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

    async initialize(schemaRegistryAddress: Address): Promise<Hash> {
        const { chain, account } = this.getWriteConfig();
        const hash = await this.walletClient.writeContract({
            address: this.contractAddress,
            abi: DS_REGISTRY_ABI,
            functionName: "initialize",
            args: [schemaRegistryAddress],
            chain,
            account,
        });
        await this.waitForTransaction(hash);
        return hash;
    }

    /// Publish or re-publish a manifest under a specific schema.
    /// schemaId must be non-zero and must exist in the SchemaRegistry.
    async publishManifest(
        manifestCid: string,
        schemaId: Hex,
    ): Promise<{ hash: Hash; version: bigint }> {
        const { chain, account } = this.getWriteConfig();
        const hash = await this.walletClient.writeContract({
            address: this.contractAddress,
            abi: DS_REGISTRY_ABI,
            functionName: "publishManifest",
            args: [manifestCid, schemaId],
            chain,
            account,
        });
        const receipt = await this.waitForTransaction(hash);
        const logs = parseEventLogs({
            abi: DS_REGISTRY_ABI,
            eventName: "ManifestPublished",
            logs: receipt.logs,
        });

        if (logs.length === 0) {
            throw new Error("publishManifest: ManifestPublished event not found in receipt");
        }
        
        const event = logs[0];
        
        const version = event.args.version;
        return { hash, version };
    }

    /// Get the manifest CID and version for a given (owner, schemaId) pair.
    async getManifest(owner: Address, schemaId: Hex): Promise<DataSource> {
        const [manifestCid, version] = await Promise.all([
            this.publicClient.readContract({
                address: this.contractAddress,
                abi: DS_REGISTRY_ABI,
                functionName: "getManifest",
                args: [owner, schemaId],
            }),
            this.publicClient.readContract({
                address: this.contractAddress,
                abi: DS_REGISTRY_ABI,
                functionName: "getVersion",
                args: [owner, schemaId],
            }),
        ]);
        return { manifestCid, schemaId, version };
    }

    /// Get the current version for a given (owner, schemaId) pair.
    async getVersion(owner: Address, schemaId: Hex): Promise<bigint> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: DS_REGISTRY_ABI,
            functionName: "getVersion",
            args: [owner, schemaId],
        });
    }

    async waitForTransaction(hash: Hash) {
        return this.publicClient.waitForTransactionReceipt({ hash });
    }
}