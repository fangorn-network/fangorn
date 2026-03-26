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
    cid: string;
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

    /// Derive the deterministic bytes32 id for a schema name (pure, no RPC call)
    async schemaId(name: string): Promise<Hex> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: SCHEMA_REGISTRY_ABI,
            functionName: "schemaId",
            args: [name],
        });
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
        const schemaId = (event?.args as { id: Hex }).id;
        return { hash, schemaId };
    }

    /// Update the spec CID and agent ID for an existing schema (owner only).
    /// Accepts either a name (resolved to id) or a raw bytes32 id.
    async updateSchema(
        nameOrId: string | Hex,
        newSpecCid: string,
        newAgentId: string,
    ): Promise<Hash> {
        const { chain, account } = this.getWriteConfig();
        const id = await this.resolveId(nameOrId);
        const hash = await this.walletClient.writeContract({
            address: this.contractAddress,
            abi: SCHEMA_REGISTRY_ABI,
            functionName: "updateSchema",
            args: [id, newSpecCid, newAgentId],
            chain,
            account,
        });
        await this.waitForTransaction(hash);
        return hash;
    }

    /// Get the full schema details. Accepts either a name or a raw bytes32 id.
    async getSchema(nameOrId: string | Hex): Promise<Schema> {
        const id = await this.resolveId(nameOrId);
        const [specCid, agentId] = await Promise.all([
            this.publicClient.readContract({
                address: this.contractAddress,
                abi: SCHEMA_REGISTRY_ABI,
                functionName: "getSchemaSpec",
                args: [id],
            }),
            this.publicClient.readContract({
                address: this.contractAddress,
                abi: SCHEMA_REGISTRY_ABI,
                functionName: "getSchemaAgent",
                args: [id],
            }),
        ]);
        return { name: typeof nameOrId === "string" ? nameOrId : id, cid: specCid, agentId };
    }

    /// Check whether a schema exists. Accepts either a name or a raw bytes32 id.
    async schemaExists(nameOrId: string | Hex): Promise<boolean> {
        const id = await this.resolveId(nameOrId);
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: SCHEMA_REGISTRY_ABI,
            functionName: "schemaExists",
            args: [id],
        });
    }

    async waitForTransaction(hash: Hash) {
        return this.publicClient.waitForTransactionReceipt({ hash });
    }

    /// Resolve a name or pre-computed bytes32 id.
    /// If the caller already has the id, no RPC call is made.
    private async resolveId(nameOrId: string | Hex): Promise<Hex> {
        if (isBytes32Hex(nameOrId)) return nameOrId;
        return this.schemaId(nameOrId);
    }
}

/// True if the value looks like a 32-byte hex string (already an id).
function isBytes32Hex(value: string): value is Hex {
    return /^0x[0-9a-fA-F]{64}$/.test(value);
}