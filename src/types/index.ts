import { Hex, WalletClient } from "viem";
import { AppConfig } from "../config.js";
import { PublisherRegistry } from "../contracts/data-registry/index.js";
// import { SchemaRoleConfig } from "../registries/settlement-registry/types.js";
import { MetadataStorage } from "../providers/storage/types.js";
import { SchemaRoleConfig } from "../roles/schema/types.js";

export interface FangornContext {
    config: AppConfig;
    walletClient: WalletClient;
    metadataStorage: MetadataStorage | undefined;
    // workerUrl: string | undefined;
    domain: string;
    dataRegistry: PublisherRegistry;
    schemaRoleConfig: SchemaRoleConfig | undefined;
}

export type StorageConfig =
    | { pinata: { jwt: string; gateway: string } };

export interface AgentConfig {
    privateKey: Hex;
    pinataJwt: string;
    registryOverrides?: Record<number, { IDENTITY: string; REPUTATION: string }>;
    subgraphOverrides?: Record<number, string>;
}

export interface FangornCreateOptions {
    storage?: StorageConfig;
    // workerUrl?: string;
    config?: AppConfig;
    domain?: string;
    agentConfig?: AgentConfig;
    privateKey?: Hex;
    walletClient?: WalletClient;
}