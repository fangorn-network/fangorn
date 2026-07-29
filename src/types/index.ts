import { Hex, WalletClient } from "viem";
import { AppConfig } from "../config.js";
import { DataRegistryClient } from "../contracts/data-registry/index.js";
import { MetadataStorage } from "../providers/storage/types.js";

export interface FangornContext {
    config: AppConfig;
    walletClient: WalletClient;
    metadataStorage: MetadataStorage | undefined;
    // workerUrl: string | undefined;
    domain: string;
    dataRegistry: DataRegistryClient;
}

export type StorageConfig =
    // Bring your own Pinata JWT + gateway.
    | { pinata: { jwt: string; gateway: string } }
    // No JWT: prove wallet ownership to the presigned-URL worker and upload via
    // the short-lived URLs it issues; read from a public IPFS gateway. Both
    // fields optional — workerUrl defaults to the hosted pinata-url-provider,
    // gateway to config.ipfsGateway.
    | { signedUrl: { workerUrl?: string; gateway?: string } };

export interface FangornCreateOptions {
    storage?: StorageConfig;
    // workerUrl?: string;
    config?: AppConfig;
    // The app (global namespace) every commit this client makes or watches is
    // scoped under: a human-readable name or a 32-byte app id. Defaults to
    // `DEFAULT_APP`; switch it later with `fangorn.setAppId()`.
    appId?: string;
    domain?: string;
    privateKey?: Hex;
    walletClient?: WalletClient;
}