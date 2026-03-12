import {
    type PublicClient,
    type WalletClient,
    type Address,
    type Hash,
    type Hex,
    parseEventLogs,
} from "viem";
import { SCHEMA_REGISTRY_ABI } from "./abi";

export interface Schema {
    name: string;
    specCid: string;
    agentId: string;
}

export class SchemaRegistry {
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

    /// Register a new schema, returns its deterministic bytes32 id
    async registerSchema(
        name: string,
        specCid: string,
        agentId: string,
    ): Promise<{ hash: Hash; schemaId: Hex }> {
        const { chain, account } = this.getWriteConfig();
        const hash = await this.walletClient.writeContract({
            address: this.contractAddress,
            abi: SCHEMA_REGISTRY_ABI,
            functionName: "registerSchema",
            args: [name, specCid, agentId],
            chain,
            account,
        });
        const receipt = await this.waitForTransaction(hash);
        const logs = parseEventLogs({ abi: SCHEMA_REGISTRY_ABI, logs: receipt.logs });
        const event = logs.find((log) => log.eventName === "SchemaRegistered");
        if (!event) {
            throw new Error("registerSchema: SchemaRegistered event not found in receipt");
        }
        const schemaId = (event.args as { id: Hex }).id;
        return { hash, schemaId };
    }

    /// Update the spec CID and agent ID for an existing schema (owner only)
    async updateSchema(
        name: string,
        newSpecCid: string,
        newAgentId: string,
    ): Promise<Hash> {
        const { chain, account } = this.getWriteConfig();
        const hash = await this.walletClient.writeContract({
            address: this.contractAddress,
            abi: SCHEMA_REGISTRY_ABI,
            functionName: "updateSchema",
            args: [name, newSpecCid, newAgentId],
            chain,
            account,
        });
        await this.waitForTransaction(hash);
        return hash;
    }

    /// Get the full schema details by name
    async getSchema(name: string): Promise<Schema> {
        const [specCid, agentId] = await Promise.all([
            this.publicClient.readContract({
                address: this.contractAddress,
                abi: SCHEMA_REGISTRY_ABI,
                functionName: "getSchemaSpec",
                args: [name],
            }) as Promise<string>,
            this.publicClient.readContract({
                address: this.contractAddress,
                abi: SCHEMA_REGISTRY_ABI,
                functionName: "getSchemaAgent",
                args: [name],
            }) as Promise<string>,
        ]);
        return { name, specCid, agentId };
    }

    /// Check whether a schema exists by its bytes32 id
    async schemaExists(schemaId: Hex): Promise<boolean> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: SCHEMA_REGISTRY_ABI,
            functionName: "schemaExists",
            args: [schemaId],
        }) as Promise<boolean>;
    }

    async waitForTransaction(hash: Hash) {
        return this.publicClient.waitForTransactionReceipt({ hash });
    }
}