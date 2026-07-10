import {
    type Address,
    type Hash,
    type Hex,
    type PublicClient,
    type WalletClient,
} from "viem";

import { DATA_REGISTRY_ABI } from "./abi.js";

// Mirroring the contract's explicit lifecycle status codes
export enum PublisherStatus {
    UNREGISTERED = 0,
    ACTIVE = 1,
    SUSPENDED = 2,
}

export class DataRegistryClient {
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
     * matching the exact gas buffer and aggressive fee styling of the protocol.
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
            abi: DATA_REGISTRY_ABI,
            functionName,
            args,
            account,
            value,
        });

        const hash = await this.walletClient.writeContract({
            address: this.contractAddress,
            abi: DATA_REGISTRY_ABI,
            functionName,
            args,
            chain,
            account,
            gas: (gas * 130n) / 100n, // 30% gas buffer safety margin
            maxFeePerGas: (fees.maxFeePerGas ?? 0n) * 3n,
            maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
            value,
        });

        await this.publicClient.waitForTransactionReceipt({ hash });

        return hash;
    }

    // ── Writes ───────────────────────────────────────────────────────────────

    /**
     * Register as a new data publisher or reactivate a suspended account.
     * Automatically reads the required on-chain fee and attaches it to the call.
     */
    async register(): Promise<Hash> {
        const fee = await this.registrationFee();
        return this.executeWrite("register", [], fee);
    }

    /**
     * The single mutating state gateway route. 
     * Enforces the sequential Compare-And-Swap (CAS) timeline rule.
     */
    async commitStateRoot(oldRoot: Hex, newRoot: Hex): Promise<Hash> {
        return this.executeWrite("commitStateRoot", [oldRoot, newRoot]);
    }

    // ── Views ────────────────────────────────────────────────────────────────

    /**
     * Obtains the authoritative timeline tracking anchor for a specific publisher's tree.
     */
    async getNamespaceHead(publisher: Address): Promise<Hex> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: DATA_REGISTRY_ABI,
            functionName: "getNamespaceHead",
            args: [publisher],
        }) as Promise<Hex>;
    }

    /**
     * Reads the explicit enum lifecycle state from the registry status machine.
     */
    async getPublisherStatus(publisher: Address): Promise<PublisherStatus> {
        const status = await this.publicClient.readContract({
            address: this.contractAddress,
            abi: DATA_REGISTRY_ABI,
            functionName: "getPublisherStatus",
            args: [publisher],
        });
        return Number(status) as PublisherStatus;
    }

    /**
     * Helper boolean view returning true if a publisher can currently commit data.
     */
    async isRegistered(publisher: Address): Promise<boolean> {
        console.log(this.contractAddress)
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: DATA_REGISTRY_ABI,
            functionName: "isRegistered",
            args: [publisher],
        }) as Promise<boolean>;
    }

    async publisherCount(): Promise<bigint> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: DATA_REGISTRY_ABI,
            functionName: "publisherCount",
        }) as Promise<bigint>;
    }

    async registrationFee(): Promise<bigint> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: DATA_REGISTRY_ABI,
            functionName: "registrationFee",
        }) as Promise<bigint>;
    }

    async admin(): Promise<Address> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: DATA_REGISTRY_ABI,
            functionName: "admin",
        }) as Promise<Address>;
    }

    // ── Admin Functions ──────────────────────────────────────────────────────

    /**
     * Allows governance or protocol administrator to immediately freeze a publisher namespace.
     */
    async suspendPublisher(publisher: Address): Promise<Hash> {
        return this.executeWrite("suspendPublisher", [publisher]);
    }

    /**
     * Adjusts the current native/token onboarding collateral tier.
     */
    async setRegistrationFee(fee: bigint): Promise<Hash> {
        return this.executeWrite("setRegistrationFee", [fee]);
    }
}