import {
    type Address,
    type Chain,
    type Hex,
    type WalletClient,
} from "viem";
import { arbitrumSepolia, baseSepolia } from "viem/chains";
import { Fangorn } from "../fangorn.js";
import { type AppConfig, FangornConfig } from "../config.js";
import { BundleInput, type SchemaDefinition, type TypeDefinition } from "../roles/schema/index.js";
import { FieldInput, PublishRecord } from "../roles/publisher/types.js";

export class TestBed {
    private constructor(
        private readonly delegatorAddress: Address,
        private readonly delegatorFangorn: Fangorn,
        private readonly delegateeFangorn: Fangorn,
    ) { }

    // NOTE: the legacy 10-arg shape is kept so existing callers (e2e + the
    // embeddings test scripts) don't have to change. The datasource/schema/
    // settlement/usdc addresses are dead now that everything proxies through the
    // publisher registry — accepted and ignored. Pass the publisher registry via
    // `publisherRegistryContractAddress` (the old dataSourceRegistry slot); it
    // falls back to the deployed default.
    static init(
        delegatorWalletClient: WalletClient,
        publisherRegistryContractAddress: Hex,
        _schemaRegistryContractAddress: Hex,
        _settlementRegistryContractAddress: Hex,
        _usdcContractAddress: Hex,
        _usdcDomainName: string,
        rpcUrl: string,
        chain: string,
        caip2: number,
        _workerUrl: string,
    ): TestBed {
        let chainImpl: Chain = arbitrumSepolia;
        if (chain === "baseSepolia") chainImpl = baseSepolia;

        const config: AppConfig = {
            publisherRegistryContractAddress:
                publisherRegistryContractAddress || FangornConfig.publisherRegistryContractAddress,
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
        );
    }

    // Schema owner
    async registerSchema(
        name: string,
        definition: SchemaDefinition,
        types?: Record<string, TypeDefinition>,
    ): Promise<Hex> {
        const { schemaId } = await this.delegatorFangorn.schema.register({
            name,
            definition,
            types,
        });
        return schemaId;
    }

    // Publisher
    async publish(
        records: PublishRecord[],
        schemaName: string,
        datasetName: string,
        chunkSize?: number,
        concurrency?: number
    ): Promise<string> {
        const { manifestUri } = await this.delegatorFangorn.publisher.publishRecords({
            records,
            schemaName,
            datasetName,
            chunkSize,
            concurrency,
        });
        return manifestUri;
    }

    // "bundle" funcs
    async registerBundle(name: string, bundle: BundleInput): Promise<Hex> {
        const { schemaId } = await this.delegatorFangorn.schema.register({
            kind: "bundle",
            name,
            bundle,
        });
        return schemaId;
    }

    async publishBundle(
        bundleName: string,
        nodes: { id: string; type: string; fields: Record<string, FieldInput> }[],
        edges: { rel: string; from: string; to: string }[],
        datasetName?: string,
    ): Promise<string> {
        const { manifestUri } = await this.getDelegatorFangorn().publisher.publishBundle({
            bundleName,
            nodes,
            edges,
            datasetName,
        });
        return manifestUri;
    }

    getDelegatorAddress(): Address { return this.delegatorAddress; }
    getDelegatorFangorn(): Fangorn { return this.delegatorFangorn; }
    getDelegateeFangorn(): Fangorn { return this.delegateeFangorn; }
}
