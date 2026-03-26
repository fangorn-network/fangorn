import { Hex, WalletClient } from "viem";
import { AppConfig } from "../config";
import { EncryptionService } from "../modules/encryption";
import { GadgetDescriptor } from "../modules/gadgets/types";
import StorageProvider from "../providers/storage";
import { SchemaRegistry } from "../registries/schema-registry";
import { DataSourceRegistry } from "../registries/datasource-registry";
import { SettlementRegistry } from "../registries/settlement-registry";
import { SchemaRoleConfig } from "../roles/schema";

// intermediate entry struct
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

// fangorn config types

/**
 * Credentials required to enable ERC-8004 agent registration via agent0-sdk.
 * Optional: omit if thewill throw. caller only needs publisher or consumer functionality.
 * When omitted, fangorn.schema.register() and fangorn.schema.get() still work;
 * only fangorn.schema.registerAgent() 
 */
export interface AgentConfig {
	privateKey: Hex;
	pinataJwt: string;
	/** Override ERC-8004 registry addresses per chainId (e.g. for Arbitrum Sepolia) */
	registryOverrides?: Record<number, { IDENTITY: string; REPUTATION: string }>;
	/** Override subgraph URLs per chainId */
	subgraphOverrides?: Record<number, string>;
}

// initialization context for lazy loading modules
export interface FangornContext {
	config: AppConfig;
	walletClient: WalletClient;
	storage: StorageProvider<unknown>;
	encryption: EncryptionService;
	domain: string;
	schemaRegistry: SchemaRegistry;
	dataSourceRegistry: DataSourceRegistry;
	settlementRegistry: SettlementRegistry;
	schemaRoleConfig: SchemaRoleConfig | undefined;
}

export type StorageConfig =
    | { pinata: { jwt: string; gateway: string } }
    | { storacha: { email: string } }
    | { storacha: { readOnly: true } }
    | StorageProvider<unknown>;
 

export type EncryptionConfig =
	| { lit: true }
	| EncryptionService;

// options for creating a fangorn instance
// e.g.
// await Fangorn.Create({  })
export interface FangornCreateOptions {
	storage: StorageConfig;
	encryption: EncryptionConfig;
	config?: AppConfig;
	domain?: string;
	agentConfig?: AgentConfig;
	// exactly one of:
	privateKey?: Hex;
	walletClient?: WalletClient;
}