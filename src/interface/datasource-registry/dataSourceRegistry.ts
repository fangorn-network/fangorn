import {
    type PublicClient,
    type WalletClient,
    type Address,
    type Hash,
    type Hex,
    parseEventLogs,
} from "viem";
import { DS_REGISTRY_ABI } from "./abi";

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

    /// Initialize with the SchemaRegistry contract address (call once after deploy)
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

    /// Publish or re-publish the caller's manifest.
    /// Pass schemaId as `0x000...0` (zero bytes32) to leave schema unset/unchanged.
    async publishManifest(
        manifestCid: string,
        schemaId: Hex = "0x0000000000000000000000000000000000000000000000000000000000000000",
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
        const logs = parseEventLogs({ abi: DS_REGISTRY_ABI, logs: receipt.logs });
        const event = logs.find((log) => log.eventName === "ManifestPublished");
        if (!event) {
            throw new Error("publishManifest: ManifestPublished event not found in receipt");
        }
        const version = (event.args as { version: bigint }).version;
        return { hash, version };
    }

    /// Get the current manifest for a given owner address
    async getManifest(owner: Address): Promise<DataSource> {
        const [manifestCid, schemaId, version] = await Promise.all([
            this.publicClient.readContract({
                address: this.contractAddress,
                abi: DS_REGISTRY_ABI,
                functionName: "getManifest",
                args: [owner],
            }) as Promise<string>,
            this.publicClient.readContract({
                address: this.contractAddress,
                abi: DS_REGISTRY_ABI,
                functionName: "getSchemaId",
                args: [owner],
            }) as Promise<Hex>,
            this.publicClient.readContract({
                address: this.contractAddress,
                abi: DS_REGISTRY_ABI,
                functionName: "getVersion",
                args: [owner],
            }) as Promise<bigint>,
        ]);
        return { manifestCid, schemaId, version };
    }
    
    async getSchemaId(owner: Address): Promise<Hex> {
        const schemaId = await this.publicClient.readContract({
                address: this.contractAddress,
                abi: DS_REGISTRY_ABI,
                functionName: "getSchemaId",
                args: [owner],
            }) as Hex;

        return schemaId;
    }

    async waitForTransaction(hash: Hash) {
        return this.publicClient.waitForTransactionReceipt({ hash });
    }
}