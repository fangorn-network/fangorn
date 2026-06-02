import {
    type Address,
    type Chain,
    type Hex,
    type WalletClient,
    createWalletClient,
    http,
} from "viem";
import { Identity } from "@semaphore-protocol/identity";
import { arbitrumSepolia, baseSepolia } from "viem/chains";
import { Fangorn } from "../fangorn.js";
import { type AppConfig } from "../config.js";
import { type SchemaDefinition } from "../roles/schema/index.js";
import { SettlementRegistry } from "../registries/settlement-registry/index.js";
import { privateKeyToAccount } from "viem/accounts";
import { DataSourceRegistry } from "../registries/datasource-registry/index.js";
import { PublishRecord } from "../roles/publisher/types.js";
import { PrepareSettleResult, TransferWithAuthPayload } from "../registries/settlement-registry/types.js";

export class TestBed {
    private constructor(
        private readonly delegatorAddress: Address,
        private readonly delegatorFangorn: Fangorn,
        private readonly delegateeFangorn: Fangorn,
        private readonly usdcContractAddress: Address,
        private readonly usdcDomainName: string,
        private readonly workerUrl: string,
    ) { }

    static init(
        delegatorWalletClient: WalletClient,
        dataSourceRegistryContractAddress: Hex,
        schemaRegistryContractAddress: Hex,
        settlementRegistryContractAddress: Hex,
        usdcContractAddress: Hex,
        usdcDomainName: string,
        rpcUrl: string,
        chain: string,
        caip2: number,
        workerUrl: string,
    ): TestBed {
        let chainImpl: Chain = arbitrumSepolia;
        if (chain === "baseSepolia") chainImpl = baseSepolia;

        const config: AppConfig = {
            dataSourceRegistryContractAddress,
            schemaRegistryContractAddress,
            settlementRegistryContractAddress,
            chainName: chain,
            chain: chainImpl,
            rpcUrl,
            caip2,
            ipfsGateway: process.env.PINATA_GATEWAY ?? "https://ipfs.io",
        };

        const delegatorFangorn = Fangorn.create({
            privateKey: (process.env.DELEGATOR_ETH_PRIVATE_KEY ?? "0x0") as Hex,
            storage: {
                pinata: {
                    jwt: process.env.PINATA_JWT ?? "",
                    gateway: process.env.PINATA_GATEWAY ?? "",
                },
            },
            config,
            domain: "localhost"
        });

        const delegateeFangorn = Fangorn.create({
            privateKey: (process.env.DELEGATEE_ETH_PRIVATE_KEY ?? "0x0") as Hex,
            config,
            domain: "localhost",
        });

        if (!delegatorWalletClient.account) throw new Error("Delegator account not found");

        return new TestBed(
            delegatorWalletClient.account.address,
            delegatorFangorn,
            delegateeFangorn,
            usdcContractAddress,
            usdcDomainName,
            workerUrl,
        );
    }

    // Schema owner
    async registerSchema(
        name: string,
        definition: SchemaDefinition,
    ): Promise<Hex> {
        const { schemaId } = await this.delegatorFangorn.schema.register({
            name,
            definition,
        });
        return schemaId;
    }

    // Publisher
    async publish(
        records: PublishRecord[],
        schemaName: string,
        datasetName: string,
        chunkSize?: any,
        concurrency?: any
    ): Promise<string> {
        const { manifestUri } = await this.delegatorFangorn.publisher.upload({
            records,
            schemaName,
            datasetName,
            chunkSize,
            concurrency,
        });
        return manifestUri;
    }

    // Consumer Phase 1: register
    async prepareRegister(
        burnerPrivateKey: Hex,
        paymentRecipient: Address,
        amount: bigint,
    ): Promise<TransferWithAuthPayload> {
        const walletClient = createWalletClient({
            account: privateKeyToAccount(burnerPrivateKey),
            chain: arbitrumSepolia,
            transport: http(process.env.RPC_URL ?? ""),
        });

        return this.delegateeFangorn.consumer.prepareRegister({
            walletClient,
            paymentRecipient,
            amount,
            usdcAddress: this.usdcContractAddress,
            usdcDomainName: this.usdcDomainName,
            usdcDomainVersion: "2",
        });
    }

    async register(
        owner: Address,
        schemaId: Hex,
        name: string,
        identityCommitment: bigint,
        relayerPrivateKey: Hex,
        preparedRegister: TransferWithAuthPayload,
    ): Promise<Hex> {
        const { txHash } = await this.delegateeFangorn.consumer.register({
            owner,
            schemaId,
            name,
            identityCommitment,
            relayerPrivateKey,
            preparedRegister,
        });
        return txHash;
    }

    // TODO!
    // // Consumer Phase 2: settle
    // async prepareSettle(
    //     owner: Address,
    //     schemaId: Hex,
    //     name: string,
    //     identity: Identity,
    //     stealthAddress: Address,
    // ): Promise<PrepareSettleResult> {
    //     return this.delegateeFangorn.consumer.prepareSettle({
    //         resourceId: DataSourceRegistry.resourceIdLocal(owner, schemaId, name),
    //         identity,
    //         stealthAddress,
    //     });
    // }

    async settle(
        owner: Address,
        schemaId: Hex,
        name: string,
        relayerPrivateKey: Hex,
        preparedSettle: PrepareSettleResult,
    ): Promise<{ txHash: Hex; nullifier: bigint }> {
        const { txHash, nullifier } = await this.delegateeFangorn.consumer.claim({
            owner,
            schemaId,
            name,
            relayerPrivateKey,
            preparedSettle,
        });
        return { txHash, nullifier };
    }

    // Consumer Phase 3: access
    async fetchContent(
        owner: Address,
        schemaId: Hex,
        name: string,
        field: string,
        nullifier: string,
        stealthPrivateKey: Hex,
    ): Promise<Uint8Array> {
        const walletClient = createWalletClient({
            account: privateKeyToAccount(stealthPrivateKey),
            chain: arbitrumSepolia,
            transport: http(process.env.RPC_URL ?? ""),
        });

        const { data } = await this.delegateeFangorn.consumer.fetchField(
            owner,
            schemaId,
            name,
            field,
            nullifier,
            walletClient,
        );
        return data;
    }

    async checkManifestExists(who: Address, schemaId: Hex, name: string): Promise<boolean> {
        const entry = await this.delegatorFangorn.consumer.checkManifestExists(who, schemaId, name);
        return entry;
    }

    getDelegatorAddress(): Address { return this.delegatorAddress; }
    getDelegatorFangorn(): Fangorn { return this.delegatorFangorn; }
    getDelegateeFangorn(): Fangorn { return this.delegateeFangorn; }
    getSettlementRegistry(): SettlementRegistry {
        return this.delegatorFangorn.getSettlementRegistry();
    }
}