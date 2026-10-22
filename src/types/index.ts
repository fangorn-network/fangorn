import { Hex, PublicClient, WalletClient } from "viem";
import { AppConfig } from "../config.js";
import { MetadataStorage } from "../providers/storage/types.js";
import { Registry } from "../registry.js";

export interface FangornContext {
    config: AppConfig;
    walletClient: WalletClient;
    publicClient: PublicClient;
    metadataStorage: MetadataStorage | undefined;
    /** Heads, membership, exclusions and logs (WHITEPAPER_1 §3.2). */
    registry: Registry;
    /**
     * The app this client reads and publishes under (the paper's context). Unset,
     * reads are each publisher's latest head, and hosted uploads are refused.
     */
    appId: Hex | undefined;
}

export type StorageConfig =
    // Bring your own Pinata JWT + gateway.
    | { pinata: { jwt: string; gateway: string } }
    // No JWT: prove wallet ownership to the presigned-URL worker and upload via
    // the short-lived URLs it issues; read from a public IPFS gateway. Apps
    // provide storage: uploads are billed to the client's app, which must admit
    // this wallet, and a client with no app cannot upload this way. A publisher
    // that pays for its own storage claims a one-member app.
    // `workerUrl` defaults to the network's hosted worker (config.signedUrlWorker),
    // `gateway` to config.ipfsGateway.
    | { signedUrl: { workerUrl?: string; gateway?: string } }
    // Any other backend, e.g. an in-memory one for tests.
    | { backend: MetadataStorage };

export interface FangornCreateOptions {
    storage?: StorageConfig;
    config?: AppConfig;
    // The app to read and publish under, by name or 32-byte id. Omit it to read
    // each publisher's own word and to publish without being presented anywhere.
    // Switch later with `fangorn.setAppId()`.
    appId?: string;
    privateKey?: Hex;
    walletClient?: WalletClient;
    // The registry to read and write history through. Defaults to the deployed
    // contracts (`ChainRegistry`).
    registry?: Registry;
}
