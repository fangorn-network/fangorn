import { Hex, WalletClient } from "viem";
import { AppConfig } from "../config.js";
import { SchemaRegistry } from "../registries/schema-registry/index.js";
import { DataSourceRegistry } from "../registries/datasource-registry/index.js";
import { SettlementRegistry } from "../registries/settlement-registry/index.js";
import { SchemaRoleConfig } from "../roles/schema/types.js";
import { MetadataStorage } from "../providers/storage/types.js";

export interface FangornContext {
    config: AppConfig;
    walletClient: WalletClient;
    metadataStorage: MetadataStorage | undefined;
    // workerUrl: string | undefined;
    domain: string;
    schemaRegistry: SchemaRegistry;
    dataSourceRegistry: DataSourceRegistry;
    settlementRegistry: SettlementRegistry;
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