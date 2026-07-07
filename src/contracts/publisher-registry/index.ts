import {
    type Address,
    type Hash,
    type Hex,
    type PublicClient,
    type WalletClient,
} from "viem";

import { PUBLISHER_REGISTRY_ABI } from "./abi.js";

export class PublisherRegistry {
    constructor(
        private contractAddress: Address,
        private publicClient: PublicClient,
        private walletClient: WalletClient,
    ) { }

    private getWriteConfig() {
        if (!this.walletClient.chain) throw new Error("Chain required");
        if (!this.walletClient.account) throw new Error("Account required");

        return {
            chain: this.walletClient.chain,
            account: this.walletClient.account,
        };
    }

    /**
     * Internal helper to execute state-mutating transactions
     * matching the gas buffer and fee style of the example.
     */
    private async executeWrite(
        functionName: string,
        args: any[],
        value?: bigint
    ): Promise<Hash> {
        const { chain, account } = this.getWriteConfig();

        const fees = await this.publicClient.estimateFeesPerGas();

        const gas = await this.publicClient.estimateContractGas({
            address: this.contractAddress,
            abi: PUBLISHER_REGISTRY_ABI,
            functionName,
            args,
            account,
            value,
        });

        const hash = await this.walletClient.writeContract({
            address: this.contractAddress,
            abi: PUBLISHER_REGISTRY_ABI,
            functionName,
            args,
            chain,
            account,
            gas: (gas * 130n) / 100n,
            // Fallback to 0n if maxFeePerGas is undefined (e.g., on legacy chains)
            maxFeePerGas: (fees.maxFeePerGas ?? 0n) * 3n,
            maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
            value,
        });

        await this.publicClient.waitForTransactionReceipt({ hash });

        return hash;
    }

    // ── Writes ───────────────────────────────────────────────────────────────

    async register(): Promise<Hash> {
        const fee = await this.registrationFee();
        return this.executeWrite("register", [], fee);
    }

    async registerSchema(
        name: string,
        specCid: string,
        agentId = "",
    ): Promise<{ hash: Hash; schemaId: Hex }> {
        const { chain, account } = this.getWriteConfig();

        // simulate to capture the contract's returned schemaId (bytes32) — the
        // authoritative id, not something we recompute off-chain.
        const schemaId = await this.publicClient.simulateContract({
            address: this.contractAddress,
            abi: PUBLISHER_REGISTRY_ABI,
            functionName: "registerSchema",
            args: [name, specCid, agentId],
            account,
        }).then(r => r.result as Hex);

        const hash = await this.walletClient.writeContract({
            address: this.contractAddress,
            abi: PUBLISHER_REGISTRY_ABI,
            functionName: "registerSchema",
            args: [name, specCid, agentId],
            chain,
            account,
        });

        await this.publicClient.waitForTransactionReceipt({ hash });
        return { hash, schemaId };
    }

    async updateSchemaAgent(
        schemaName: string,
        newAgentId: string
    ): Promise<Hash> {
        return this.executeWrite("updateSchemaAgent", [schemaName, newAgentId]);
    }

    async deleteSchema(schemaName: string): Promise<Hash> {
        return this.executeWrite("deleteSchema", [schemaName]);
    }

    async publish(
        manifestCid: string,
        merkleRoot: Hex,
        schemaName: string,
        name: string,
    ): Promise<Hash> {
        return this.executeWrite("publish", [manifestCid, merkleRoot, schemaName, name]);
    }

    async setRegistrationFee(fee: bigint): Promise<Hash> {
        return this.executeWrite("setRegistrationFee", [fee]);
    }

    async setFactory(factory: Address): Promise<Hash> {
        return this.executeWrite("setFactory", [factory]);
    }

    // ── Reads ────────────────────────────────────────────────────────────────

    async bucketOf(publisher: Address): Promise<Address> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: PUBLISHER_REGISTRY_ABI,
            functionName: "bucketOf",
            args: [publisher],
        }) as Promise<Address>;
    }

    async ownerOf(bucket: Address): Promise<Address> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: PUBLISHER_REGISTRY_ABI,
            functionName: "ownerOf",
            args: [bucket],
        }) as Promise<Address>;
    }

    async isRegistered(publisher: Address): Promise<boolean> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: PUBLISHER_REGISTRY_ABI,
            functionName: "isRegistered",
            args: [publisher],
        }) as Promise<boolean>;
    }

    async publisherCount(): Promise<bigint> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: PUBLISHER_REGISTRY_ABI,
            functionName: "publisherCount",
        }) as Promise<bigint>;
    }

    async registrationFee(): Promise<bigint> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: PUBLISHER_REGISTRY_ABI,
            functionName: "registrationFee",
        }) as Promise<bigint>;
    }

    async admin(): Promise<Address> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: PUBLISHER_REGISTRY_ABI,
            functionName: "admin",
        }) as Promise<Address>;
    }

    async factory(): Promise<Address> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: PUBLISHER_REGISTRY_ABI,
            functionName: "factory",
        }) as Promise<Address>;
    }

    // ── Forwarded Bucket Data Getters ─────────────────────────────────────────

    async getBucketSchemaExists(
        publisher: Address,
        schemaId: Hex
    ): Promise<boolean> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: PUBLISHER_REGISTRY_ABI,
            functionName: "getBucketSchemaExists",
            args: [publisher, schemaId],
        }) as Promise<boolean>;
    }

    async getBucketSchema(
        publisher: Address,
        schemaName: string
    ): Promise<{ name: string; schemaId: Hex, specCid: string; agentId: string }> {
        const [name, schemaId, specCid, agentId] = await this.publicClient.readContract({
            address: this.contractAddress,
            abi: PUBLISHER_REGISTRY_ABI,
            functionName: "getBucketSchema",
            args: [publisher, schemaName],
        }) as [string, Hex, string, string];

        return { name, schemaId, specCid, agentId };
    }

    async getBucketManifest(
        publisher: Address,
        schemaName: string,
        name: string
    ): Promise<{ manifestCid: string; merkleRoot: Hex }> {
        const [manifestCid, merkleRoot] = await this.publicClient.readContract({
            address: this.contractAddress,
            abi: PUBLISHER_REGISTRY_ABI,
            functionName: "getBucketManifest",
            args: [publisher, schemaName, name],
        }) as [string, Hex];

        return { manifestCid, merkleRoot };
    }

    async getBucketMerkleRoot(
        publisher: Address,
        schemaName: string,
        name: string
    ): Promise<Hex> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: PUBLISHER_REGISTRY_ABI,
            functionName: "getBucketMerkleRoot",
            args: [publisher, schemaName, name],
        }) as Promise<Hex>;
    }

    async getBucketVersion(
        publisher: Address,
        schemaName: string,
        name: string
    ): Promise<bigint> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: PUBLISHER_REGISTRY_ABI,
            functionName: "getBucketVersion",
            args: [publisher, schemaName, name],
        }) as Promise<bigint>;
    }

    async getBucketNameByHash(
        publisher: Address,
        schemaName: string,
        nameHash: Hex
    ): Promise<string> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: PUBLISHER_REGISTRY_ABI,
            functionName: "getBucketNameByHash",
            args: [publisher, schemaName, nameHash],
        }) as Promise<string>;
    }

    async getBucketResourceId(
        publisher: Address,
        schemaId: Hex,
        name: string
    ): Promise<Hex> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: PUBLISHER_REGISTRY_ABI,
            functionName: "getBucketResourceId",
            args: [publisher, schemaId, name],
        }) as Promise<Hex>;
    }
}