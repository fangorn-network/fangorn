import { Hex, PublicClient, WalletClient } from "viem";
import { AppConfig } from "../config.js";
import { MetadataStorage } from "../providers/storage/types.js";
import { Registry } from "../registry.js";

export interface FangornContext {
    config: AppConfig;
    walletClient: WalletClient;
    publicClient: PublicClient;
    metadataStorage: MetadataStorage | undefined;
    /** Heads and the update log (WHITEPAPER_1 §3.2). */
    registry: Registry;
    /** The app this client manages, if any. */
    appId: Hex | undefined;
}

export type StorageConfig =
    // Bring your own Pinata JWT + gateway.
    | { pinata: { jwt: string; gateway: string } }
    // No JWT: prove wallet ownership to the presigned-URL worker and upload via
    // the short-lived URLs it issues; read from a public IPFS gateway. Uploads
    // count against the signing publisher's storage quota.
    // `workerUrl` defaults to the network's hosted worker (config.signedUrlWorker),
    // `gateway` to config.ipfsGateway.
    | { signedUrl: { workerUrl?: string; gateway?: string } }
    // Any other backend, e.g. an in-memory one for tests.
    | { backend: MetadataStorage };

export interface FangornCreateOptions {
    storage?: StorageConfig;
    config?: AppConfig;
    // The app this client manages, by name or 32-byte id. Switch later with
    // `fangorn.setAppId()`.
    appId?: string;
    privateKey?: Hex;
    walletClient?: WalletClient;
    // The registry to read and write history through. Defaults to the deployed
    // contracts (`ChainRegistry`).
    registry?: Registry;
}
