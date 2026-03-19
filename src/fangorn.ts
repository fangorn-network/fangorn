
import {
	createPublicClient,
	http,
	type Hex,
	type PublicClient,
	type WalletClient,
} from "viem";
import { AppConfig, FangornConfig } from "./config.js";
import type StorageProvider from "./providers/storage/index.js";
import type { EncryptionService } from "./modules/encryption/index.js";
import { SchemaRole } from "./roles/schema/index.js";
import { PublisherRole } from "./roles/publisher/index.js";
import { ConsumerRole } from "./roles/consumer/index.js";
import { SchemaRegistry } from "./registries/schema-registry/index.js";
import { DataSourceRegistry } from "./registries/datasource-registry/index.js";
import { SettlementRegistry } from "./registries/settlement-registry/index.js";
import { SchemaRoleConfig } from "./roles/schema/types.js";

/**
 * Credentials required to enable ERC-8004 agent registration via agent0-sdk.
 * Optional — omit if the caller only needs publisher or consumer functionality.
 * When omitted, fangorn.schema.register() and fangorn.schema.get() still work;
 * only fangorn.schema.registerAgent() will throw.
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
interface FangornContext {
	walletClient: WalletClient;
	storage: StorageProvider<unknown>;
	encryption: EncryptionService;
	domain: string;
	schemaRegistry: SchemaRegistry;
	dataSourceRegistry: DataSourceRegistry;
	settlementRegistry: SettlementRegistry;
	schemaRoleConfig: SchemaRoleConfig | undefined;
}

export class Fangorn {
	private readonly ctx: FangornContext;

	// Backing fields (null until first access)
	private _schema: SchemaRole | null = null;
	private _publisher: PublisherRole | null = null;
	private _consumer: ConsumerRole | null = null;

	private constructor(ctx: FangornContext) {
		this.ctx = ctx;
	}

	/**
	 * Schema owner role — register agents, register schemas, validate definitions.
	 * Constructed once on first access.
	 */
	get schema(): SchemaRole {
		return this._schema ??= new SchemaRole(
			this.ctx.schemaRegistry,
			this.ctx.storage,
			this.ctx.walletClient,
			this.ctx.schemaRoleConfig,
		);
	}

	/**
	 * Publisher role — encrypt, stage, and commit data under a schema.
	 * Constructed once on first access.
	 */
	get publisher(): PublisherRole {
		return this._publisher ??= new PublisherRole(
			this.ctx.dataSourceRegistry,
			this.ctx.settlementRegistry,
			this.ctx.storage,
			this.ctx.encryption,
			this.ctx.walletClient,
		);
	}

	/**
	 * Consumer role — purchase, claim, and decrypt data.
	 * Constructed once on first access.
	 */
	get consumer(): ConsumerRole {
		return this._consumer ??= new ConsumerRole(
			this.ctx.dataSourceRegistry,
			this.ctx.settlementRegistry,
			this.ctx.storage,
			this.ctx.encryption,
			// this.ctx.walletClient,
			this.ctx.domain,
		);
	}

	/**
	 * Initialize Fangorn.
	 *
	 * @param walletClient  Viem wallet client with a connected account
	 * @param storage       Storage provider (e.g. PinataStorage)
	 * @param encryption    Encryption service (e.g. LitEncryptionService)
	 * @param domain        EIP-712 signing domain — must match the encryption service
	 * @param config        Network + contract config. Defaults to ArbitrumSepolia.
	 * @param agentConfig   Optional. Required only for schema.registerAgent().
	 */
	static init(
		walletClient: WalletClient,
		storage: StorageProvider<unknown>,
		encryption: EncryptionService,
		domain: string,
		config?: AppConfig,
		agentConfig?: AgentConfig,
	): Fangorn {
		const resolvedConfig = config ?? FangornConfig.ArbitrumSepolia;

		const publicClient = createPublicClient({
			transport: http(resolvedConfig.rpcUrl),
		}) as PublicClient;

		const schemaRegistry = new SchemaRegistry(
			resolvedConfig.schemaRegistryContractAddress,
			publicClient,
			walletClient,
		);

		const dataSourceRegistry = new DataSourceRegistry(
			resolvedConfig.dataSourceRegistryContractAddress,
			publicClient,
			walletClient,
		);

		const settlementRegistry = new SettlementRegistry(
			resolvedConfig.settlementRegistryContractAddress,
			publicClient,
			walletClient,
		);

		const schemaRoleConfig: SchemaRoleConfig | undefined = agentConfig
			? {
				chainId: 421614,
				rpcUrl: resolvedConfig.rpcUrl,
				privateKey: agentConfig.privateKey,
				pinataJwt: agentConfig.pinataJwt,
				registryOverrides: agentConfig.registryOverrides,
				subgraphOverrides: agentConfig.subgraphOverrides,
			}
			: undefined;

		return new Fangorn({
			walletClient,
			storage,
			encryption,
			domain,
			schemaRegistry,
			dataSourceRegistry,
			settlementRegistry,
			schemaRoleConfig,
		});
	}

	getSchemaRegistry(): SchemaRegistry {
		return this.ctx.schemaRegistry;
	}

	getDatasourceRegistry(): DataSourceRegistry {
		return this.ctx.dataSourceRegistry;
	}

	getSettlementRegistry(): SettlementRegistry {
		return this.ctx.settlementRegistry;
	}

	getWalletClient(): WalletClient {
		return this.ctx.walletClient;
	}

	getAddress(): Hex {
		const address = this.ctx.walletClient.account?.address;
		if (!address) throw new Error("No account connected to wallet client");
		return address;
	}
}
