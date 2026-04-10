import {
    type PublicClient,
    type WalletClient,
    type Address,
    type Hash,
    type Hex,
    keccak256,
    encodePacked,
} from "viem";
import { DS_REGISTRY_ABI } from "./abi.js";

export interface DataSource {
    manifestCid: string;
    name: string;
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

    /// Publish or update a named data source entry under a schema.
    /// On first publish: creates the Semaphore group in the settlement registry.
    /// On update: mutates price and CID; the group stays stable.
    async publish(
        manifestCid: string,
        schemaId: Hex,
        name: string,
        price: bigint,
        gas?: bigint,
    ): Promise<Hash> {
        const { chain, account } = this.getWriteConfig();
        const gasLimit = await this.estimateGas(
            () => this.publicClient.estimateContractGas({
                address: this.contractAddress,
                abi: DS_REGISTRY_ABI,
                functionName: "publish",
                args: [manifestCid, schemaId, name, price],
                account,
            }),
            gas,
        );
        const fees = await this.publicClient.estimateFeesPerGas();

        const hash = await this.walletClient.writeContract({
            address: this.contractAddress,
            abi: DS_REGISTRY_ABI,
            functionName: "publish",
            args: [manifestCid, schemaId, name, price],
            chain,
            account,
            gas: gasLimit,
            maxFeePerGas: fees.maxFeePerGas * 3n,
            maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        });
        await this.waitForTransaction(hash);
        return hash;
    }

    /// Get the manifest CID and metadata for a given (owner, schemaId, name) triple.
    async get(owner: Address, schemaId: Hex, name: string): Promise<DataSource> {
        const nameHash = this.hashName(name);
        const [manifestCid, version] = await Promise.all([
            this.publicClient.readContract({
                address: this.contractAddress,
                abi: DS_REGISTRY_ABI,
                functionName: "get",
                args: [owner, schemaId, name],
            }) as Promise<string>,
            this.publicClient.readContract({
                address: this.contractAddress,
                abi: DS_REGISTRY_ABI,
                functionName: "getVersion",
                args: [owner, schemaId, name],
            }) as Promise<bigint>,
        ]);
        return { manifestCid, name, schemaId, version };
    }

    /// Get by pre-computed name_hash. Useful when you have the hash
    /// but not the original string (e.g. from an on-chain event).
    async getByHash(
        owner: Address,
        schemaId: Hex,
        nameHash: Hex,
    ): Promise<string> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: DS_REGISTRY_ABI,
            functionName: "getByHash",
            args: [owner, schemaId, nameHash],
        }) as Promise<string>;
    }

    /// Recover the original name string from a name_hash.
    async getName(
        owner: Address,
        schemaId: Hex,
        nameHash: Hex,
    ): Promise<string> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: DS_REGISTRY_ABI,
            functionName: "getName",
            args: [owner, schemaId, nameHash],
        }) as Promise<string>;
    }

    async getVersion(owner: Address, schemaId: Hex, name: string): Promise<bigint> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: DS_REGISTRY_ABI,
            functionName: "getVersion",
            args: [owner, schemaId, name],
        }) as Promise<bigint>;
    }

    /// Derive the resource_id (Semaphore group id) via contract call.
    async resourceId(owner: Address, schemaId: Hex, name: string): Promise<Hex> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: DS_REGISTRY_ABI,
            functionName: "resourceId",
            args: [owner, schemaId, name],
        }) as Promise<Hex>;
    }

    /// Derive the resource_id client-side without an RPC call.
    /// Matches the contract's derive_resource_id exactly:
    ///   keccak256(owner ++ schema_id ++ keccak256(name))
    public static resourceIdLocal(owner: Address, schemaId: Hex, name: string): Hex {
        const nameHash = keccak256(new TextEncoder().encode(name) as Uint8Array<ArrayBuffer>);
        return keccak256(
            encodePacked(
                ["address", "bytes32", "bytes32"],
                [owner, schemaId, nameHash],
            ),
        );
    }

    /// keccak256 of the UTF-8 name string, matching the contract's on-chain hash.
    hashName(name: string): Hex {
        return keccak256(new TextEncoder().encode(name) as Uint8Array<ArrayBuffer>);
    }

    async waitForTransaction(hash: Hash) {
        return this.publicClient.waitForTransactionReceipt({ hash });
    }

    private async estimateGas(
        fn: () => Promise<bigint>,
        override?: bigint,
    ): Promise<bigint> {
        if (override !== undefined) return override;
        const estimated = await fn();
        return (estimated * 130n) / 100n;
    }
}