import {
    type PublicClient,
    type WalletClient,
    type Address,
    type Hash,
    type Hex,
} from "viem";
import { SCHEMA_REGISTRY_ABI } from "./abi";

export interface Schema {
    name: string;
    specCid: string;
    agentId: string;
    owner: Address;
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

    // ── Schema id ─────────────────────────────────────────────────────────────

    async schemaId(name: string): Promise<Hex> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: SCHEMA_REGISTRY_ABI,
            functionName: "schemaId",
            args: [name],
        });
    }

    // ── Writes ────────────────────────────────────────────────────────────────

    async registerSchema(
        name: string,
        specCid: string,
        agentId = "",
    ): Promise<{ hash: Hash; schemaId: Hex }> {
        const { chain, account } = this.getWriteConfig();

        const schemaId = await this.publicClient.simulateContract({
            address: this.contractAddress,
            abi: SCHEMA_REGISTRY_ABI,
            functionName: "registerSchema",
            args: [name, specCid, agentId],
            account,
        }).then(r => r.result);

        const hash = await this.walletClient.writeContract({
            address: this.contractAddress,
            abi: SCHEMA_REGISTRY_ABI,
            functionName: "registerSchema",
            args: [name, specCid, agentId],
            chain,
            account,
        });

        await this.waitForTransaction(hash);
        return { hash, schemaId };
    }

    async updateSchema(
        nameOrId: string,
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

    async deleteSchema(nameOrId: string): Promise<Hash> {
        const { chain, account } = this.getWriteConfig();
        const id = await this.resolveId(nameOrId);
        const hash = await this.walletClient.writeContract({
            address: this.contractAddress,
            abi: SCHEMA_REGISTRY_ABI,
            functionName: "deleteSchema",
            args: [id],
            chain,
            account,
        });
        await this.waitForTransaction(hash);
        return hash;
    }

    // ── Reads ─────────────────────────────────────────────────────────────────

    async getSchema(nameOrId: string): Promise<Schema> {
        const id = await this.resolveId(nameOrId);
        const [specCid, agentId, name, owner] = await Promise.all([
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
            this.publicClient.readContract({
                address: this.contractAddress,
                abi: SCHEMA_REGISTRY_ABI,
                functionName: "getSchemaName",
                args: [id],
            }),
            this.publicClient.readContract({
                address: this.contractAddress,
                abi: SCHEMA_REGISTRY_ABI,
                functionName: "getSchemaOwner",
                args: [id],
            }),
        ]);
        return { name, specCid, agentId, owner };
    }

    async schemaExists(nameOrId: string): Promise<boolean> {
        const id = await this.resolveId(nameOrId);
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: SCHEMA_REGISTRY_ABI,
            functionName: "schemaExists",
            args: [id],
        });
    }

    async hasPublishers(nameOrId: string): Promise<boolean> {
        const id = await this.resolveId(nameOrId);
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: SCHEMA_REGISTRY_ABI,
            functionName: "hasPublishers",
            args: [id],
        });
    }

    async isPublisher(nameOrId: string, publisher: Address): Promise<boolean> {
        const id = await this.resolveId(nameOrId);
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: SCHEMA_REGISTRY_ABI,
            functionName: "isPublisher",
            args: [id, publisher],
        });
    }

    async getPublisherCount(nameOrId: string): Promise<bigint> {
        const id = await this.resolveId(nameOrId);
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: SCHEMA_REGISTRY_ABI,
            functionName: "getPublisherCount",
            args: [id],
        });
    }

    async waitForTransaction(hash: Hash) {
        return this.publicClient.waitForTransactionReceipt({ hash });
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    private async resolveId(nameOrId: string): Promise<Hex> {
        if (isBytes32Hex(nameOrId)) return nameOrId as Hex;
        return this.schemaId(nameOrId);
    }
}

function isBytes32Hex(value: string): boolean {
    return /^0x[0-9a-fA-F]{64}$/.test(value);
}