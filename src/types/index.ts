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
    | { pinata: { jwt: string; gateway: string } };

export interface FangornCreateOptions {
    storage?: StorageConfig;
    // workerUrl?: string;
    config?: AppConfig;
    domain?: string;
    privateKey?: Hex;
    walletClient?: WalletClient;
}