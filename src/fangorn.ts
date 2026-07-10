import {
    createPublicClient,
    createWalletClient,
    http,
    type Hex,
    type PublicClient,
    type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { AppConfig, FangornConfig } from "./config.js";
import { FangornContext, FangornCreateOptions, StorageConfig } from "./types/index.js";
import { MetadataStorage } from "./providers/storage/types.js";
import { PinataBackend } from "./providers/storage/pinata.js";
import { FangornEngine, MetagraphRegistry } from "./engine/index.js";
import { StorageBlockstoreAdapter } from "./engine/blockstore.js";
import { DataRegistryClient } from "./contracts/index.js";

function isPinataConfig(s: StorageConfig): s is { pinata: { jwt: string; gateway: string } } {
    return "pinata" in (s as object);
}

function resolveStorage(storage?: StorageConfig): MetadataStorage | undefined {
    if (!storage) return undefined;
    if (isPinataConfig(storage)) return new PinataBackend(storage.pinata.jwt, storage.pinata.gateway);
    throw new Error(`Invalid storage config: must be { pinata: { jwt, gateway } }, got ${JSON.stringify(storage)}`);
}

export class Fangorn {
    private readonly ctx: FangornContext;
    private _engine: FangornEngine | null = null;
    private _metagraph: MetagraphRegistry | null = null;

    private constructor(ctx: FangornContext) {
        this.ctx = ctx;
    }

    get engine(): FangornEngine {
        if (!this.ctx.metadataStorage) {
            throw new Error("fangorn.engine requires storage configurations. Pass { pinata: { ... } } to Fangorn.create()");
        }
        if (!this._engine) {
            const blockstoreAdapter = new StorageBlockstoreAdapter(this.ctx.metadataStorage);
            this._metagraph = new MetagraphRegistry();

            this._engine = new FangornEngine(
                blockstoreAdapter,
                this._metagraph,
                this.ctx.dataRegistry
            );
        }
        return this._engine;
    }

    get metagraph(): MetagraphRegistry {
        const _ = this.engine;
        return this._metagraph!;
    }

    static create(options: FangornCreateOptions): Fangorn {
        if (!options.privateKey && !options.walletClient) {
            throw new Error("Either privateKey or walletClient must be provided");
        }

        const resolvedConfig = options.config ?? FangornConfig;

        const walletClient = options.walletClient ?? createWalletClient({
            account: privateKeyToAccount(options.privateKey ?? "0x0"),
            chain: resolvedConfig.chain,
            transport: http(resolvedConfig.rpcUrl),
        });

        const metadataStorage = resolveStorage(options.storage);
        const domain = options.domain ?? new URL(resolvedConfig.rpcUrl).hostname;

        const publicClient = createPublicClient({
            transport: http(resolvedConfig.rpcUrl),
        }) as PublicClient;

        const dataRegistry = new DataRegistryClient(
            resolvedConfig.dataRegistryContractAddress,
            publicClient,
            walletClient,
        );

        const schemaRoleConfig = options.agentConfig
            ? {
                chainId: resolvedConfig.chain.id,
                rpcUrl: resolvedConfig.rpcUrl,
                privateKey: options.agentConfig.privateKey,
                pinataJwt: options.agentConfig.pinataJwt,
                registryOverrides: options.agentConfig.registryOverrides,
                subgraphOverrides: options.agentConfig.subgraphOverrides,
            }
            : undefined;

        return new Fangorn({
            walletClient,
            metadataStorage,
            domain,
            dataRegistry: dataRegistry as any,
            schemaRoleConfig,
            config: resolvedConfig,
        });
    }

    /**
     * Allocates a namespace key directly within the transactional Pail index tree.
     */
    async initRepo(repoName: string) {
        const publisher = this.getAddress();

        // 1. Initialize Pail batch based on current on-chain root head hex
        const { batch, contractHeadHex } = await this.engine.createBatch(publisher);

        // 2. Safely check if repository has been set in this Pail index state machine
        // We look for a special initialization layout string
        const repoInitMarkerKey = `${repoName}/sys/init`;
        const exists = await batch.get(repoInitMarkerKey);
        if (exists) {
            throw new Error(`Repository '${repoName}' already exists.`);
        }

        // 3. Mark repository as active inside the batch state frame
        // Storing a simple string byte pointer to declare the prefix space open
        await batch.put(repoInitMarkerKey, "initialized");

        console.log(`[Fangorn] Committing repository '${repoName}' directly inside structural graph...`);
        
        // 4. Commit using engine logic to produce standard CommitObject and settle on-chain
        const { commitCid, txHash } = await this.engine.commitBatch(
            batch,
            publisher,
            contractHeadHex,
            `Initialize repository workspace: ${repoName}`
        );

        return { 
            cid: commitCid.toString(), 
            txHash 
        };
    }

    /**
     * Stages a node payload against structural metadata rules inside the Pail collection context.
     */
    async upload(repoName: string, payload: any, schemaId: string) {
        const publisher = this.getAddress();

        // 1. Pull batch reference tracking current head
        const { batch, contractHeadHex } = await this.engine.createBatch(publisher);

        // 2. Ensure repository is verified and initialized inside current structural snapshot
        const repoInitMarkerKey = `${repoName}/sys/init`;
        const initialized = await batch.get(repoInitMarkerKey);
        if (!initialized) {
            throw new Error(`Repository '${repoName}' does not exist. Call initRepo() prior to uploading.`);
        }

        console.log(`[Fangorn] Staging vertex to repository workspace...`);
        
        // 3. Build and record standard IPLD node block
        const vertexCidString = await this.engine.stageVertex(
            batch,
            repoName,
            schemaId,
            payload
        );

        // 4. Close transaction, compute updated root digest state, and seal on-chain
        const { commitCid, txHash } = await this.engine.commitBatch(
            batch,
            publisher,
            contractHeadHex,
            `Upload to namespace ${repoName} under schema ${schemaId}`
        );

        return {
            payloadCid: vertexCidString,
            commitCid: commitCid.toString(),
            txHash
        };
    }

    getConfig(): AppConfig { return this.ctx.config; }

    getDataRegistry(): DataRegistryClient { return this.ctx.dataRegistry as any; }

    getStorage(): MetadataStorage {
        if (!this.ctx.metadataStorage) {
            throw new Error("storage is not configured. Pass { pinata: { ... } } to Fangorn.create()");
        }
        return this.ctx.metadataStorage;
    }

    getWalletClient(): WalletClient { return this.ctx.walletClient; }

    getAddress(): Hex {
        const address = this.ctx.walletClient.account?.address;
        if (!address) throw new Error("No account connected to wallet client");
        return address;
    }
}