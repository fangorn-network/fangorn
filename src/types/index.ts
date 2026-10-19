import { Hex, PublicClient, WalletClient } from "viem";
import { AppConfig } from "../config.js";
import { MetadataStorage } from "../providers/storage/types.js";
import { Registry } from "../registry.js";

export interface FangornContext {
    config: AppConfig;
    walletClient: WalletClient;
    publicClient: PublicClient;
    metadataStorage: MetadataStorage | undefined;
    /** Heads, acceptances, exclusions and logs (WHITEPAPER_1 §3.2). */
    registry: Registry;
    /**
     * The app this client reads and publishes under (the paper's context). Unset,
     * reads are each publisher's own word and updates carry no acceptance.
     */
    appId: Hex | undefined;
}

export type StorageConfig =
    // Bring your own Pinata JWT + gateway.
    | { pinata: { jwt: string; gateway: string } }
    // No JWT: prove wallet ownership to the presigned-URL worker and upload via
    // the short-lived URLs it issues; read from a public IPFS gateway. The worker
    // bills `sponsor` (an app name or id that admits this wallet), defaulting to
    // the client's app; with neither, only its free tier applies. A publisher
    // that pays for its own storage claims a one-member app and sponsors itself.
    // `workerUrl` defaults to the hosted pinata-url-provider, `gateway` to
    // config.ipfsGateway.
    | { signedUrl: { workerUrl?: string; gateway?: string; sponsor?: string } }
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
