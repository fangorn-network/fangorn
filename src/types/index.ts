import { Hex, WalletClient } from "viem";
import { AppConfig } from "../config";
import { EncryptionService } from "../modules/encryption";
import { GadgetDescriptor } from "../modules/gadgets/types";
import { SchemaRegistry } from "../registries/schema-registry";
import { DataSourceRegistry } from "../registries/datasource-registry";
import { SettlementRegistry } from "../registries/settlement-registry";
import { SchemaRoleConfig } from "../roles/schema";
import { PinningService } from "../providers/storage";

export interface PendingEntry {
    tag: string;
    cid: string;
    gadgetDescriptor: GadgetDescriptor;
    extension: string;
    fileType: string;
}

export interface Filedata {
    tag: string;
    data: Uint8Array;
    extension: string;
    fileType: string;
}

export interface EncryptedData {
    ciphertext: Uint8Array<ArrayBuffer>;
    iv: Uint8Array<ArrayBuffer>;
    authTag: Uint8Array<ArrayBuffer>;
    salt: Uint8Array<ArrayBuffer>;
}

export interface AgentConfig {
    privateKey: Hex;
    pinataJwt: string;
    registryOverrides?: Record<number, { IDENTITY: string; REPUTATION: string }>;
    subgraphOverrides?: Record<number, string>;
}

export interface FangornContext {
    config: AppConfig;
    walletClient: WalletClient;
    storage: PinningService | undefined;
    encryption: EncryptionService;
    domain: string;
    ipfsGateway: string;
    schemaRegistry: SchemaRegistry;
    dataSourceRegistry: DataSourceRegistry;
    settlementRegistry: SettlementRegistry;
    schemaRoleConfig: SchemaRoleConfig | undefined;
}

export type StorageConfig =
    | { pinata: { jwt: string; gateway: string } };

export type EncryptionConfig =
    | { lit: true }
    | EncryptionService;

export interface FangornCreateOptions {
    /**
     * Pinning service config. Required for publisher and schema roles.
     * Omit for consumer-only usage — reads always go through the public IPFS gateway.
     */
    storage?: StorageConfig;
    encryption: EncryptionConfig;
    ipfsGateway?: string;
    config?: AppConfig;
    domain?: string;
    agentConfig?: AgentConfig;
    privateKey?: Hex;
    walletClient?: WalletClient;
}