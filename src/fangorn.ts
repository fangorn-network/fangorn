import {
	createPublicClient,
	createWalletClient,
	http,
	type Hex,
	type PublicClient,
	type WalletClient,
} from "viem";
import { AppConfig, FangornConfig } from "./config.js";
import { LitEncryptionService, type EncryptionService } from "./modules/encryption/index.js";
import { SchemaRole } from "./roles/schema/index.js";
import { PublisherRole } from "./roles/publisher/index.js";
import { ConsumerRole } from "./roles/consumer/index.js";
import { SchemaRegistry } from "./registries/schema-registry/index.js";
import { DataSourceRegistry } from "./registries/datasource-registry/index.js";
import { SettlementRegistry } from "./registries/settlement-registry/index.js";
import { SchemaRoleConfig } from "./roles/schema/types.js";
import { EncryptionConfig, FangornContext, FangornCreateOptions, StorageConfig } from "./types/index.js";
import { privateKeyToAccount } from "viem/accounts";
import { PinataStorage, ReadableStorage, WritableStorage } from "./providers/storage/index.js";
import { StorachaStorage } from "./providers/storage/storacha/index.js";
import { ReadOnlyStorachaStorage } from "./providers/storage/storacha/readOnly.js";

// ── Encryption ────────────────────────────────────────────────────────────────

function isEncryptionService(e: EncryptionConfig): e is EncryptionService {
	return typeof (e as EncryptionService).encrypt === "function";
}

// ── Storage resolution ────────────────────────────────────────────────────────

// function isStorageProvider(s: StorageConfig): s is StorageProvider<unknown> {
// 	return typeof (s as StorageProvider<unknown>).retrieve === "function";
// }

function isPinataConfig(s: StorageConfig): s is { pinata: { jwt: string; gateway: string } } {
	return "pinata" in (s as object);
}

function isStorachaReadOnly(s: StorageConfig): boolean {
	return "storacha" in (s as object) && "readOnly" in ((s as { storacha: object }).storacha);
}

function isStorachaConfig(s: StorageConfig): s is { storacha: { email: string } } {
	return "storacha" in (s as object) && "email" in ((s as { storacha: object }).storacha);
}

function isWritable(s: ReadableStorage<unknown>): s is WritableStorage<unknown> {
	return "store" in s && "delete" in s;
}

async function resolveStorage(storage: StorageConfig): Promise<ReadableStorage<unknown>> {
	// if (isStorageProvider(storage)) return storage;
	if (isPinataConfig(storage)) return new PinataStorage(storage.pinata.jwt, storage.pinata.gateway);
	if (isStorachaReadOnly(storage)) return new ReadOnlyStorachaStorage();
	if (isStorachaConfig(storage)) return StorachaStorage.create(storage.storacha.email);
	throw new Error(
		"Invalid storage config: must be a StorageProvider instance, " +
		"a { pinata } object, or a { storacha } object.",
	);
}

// ── Fangorn ───────────────────────────────────────────────────────────────────

export class Fangorn {
	private readonly ctx: FangornContext;

	private _schema: SchemaRole | null = null;
	private _publisher: PublisherRole | null = null;
	private _consumer: ConsumerRole | null = null;

	private constructor(ctx: FangornContext) {
		this.ctx = ctx;
	}

	/**
	 * Schema owner: register agents, register schemas, validate definitions.
	 * Requires writable storage.
	 */
	get schema(): SchemaRole {
		if (!isWritable(this.ctx.storage)) {
			throw new Error("fangorn.schema requires writable storage — use { storacha: { email } } or { pinata: { ... } }");
		}
		return this._schema ??= new SchemaRole(
			this.ctx.schemaRegistry,
			this.ctx.storage,
			this.ctx.walletClient,
			this.ctx.schemaRoleConfig,
		);
	}

	/**
	 * Publisher: encrypt, stage, and commit data under a schema.
	 * Requires writable storage.
	 */
	get publisher(): PublisherRole {
		if (!isWritable(this.ctx.storage)) {
			throw new Error("fangorn.publisher requires writable storage — use { storacha: { email } } or { pinata: { ... } }");
		}
		return this._publisher ??= new PublisherRole(
			this.ctx.dataSourceRegistry,
			this.ctx.settlementRegistry,
			this.ctx.storage,
			this.ctx.encryption,
			this.ctx.walletClient,
		);
	}

	/**
	 * Consumer: purchase, claim, and decrypt data.
	 * Works with both readable and writable storage.
	 */
	get consumer(): ConsumerRole {
		return this._consumer ??= new ConsumerRole(
			this.ctx.dataSourceRegistry,
			this.ctx.settlementRegistry,
			this.ctx.storage,
			this.ctx.encryption,
			this.ctx.domain,
		);
	}

	static async create(options: FangornCreateOptions): Promise<Fangorn> {
		if (!options.privateKey && !options.walletClient) {
			throw new Error("Either privateKey or walletClient must be provided");
		}

		const resolvedConfig = options.config ?? FangornConfig.ArbitrumSepolia;

		const walletClient = options.walletClient ?? createWalletClient({
			account: privateKeyToAccount(options.privateKey ?? "0x0"),
			chain: resolvedConfig.chain,
			transport: http(resolvedConfig.rpcUrl),
		});

		const storage = await resolveStorage(options.storage);

		const encryption = isEncryptionService(options.encryption)
			? options.encryption
			: await LitEncryptionService.init(resolvedConfig.chainName);

		const domain = options.domain ?? new URL(resolvedConfig.rpcUrl).hostname;

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

		const schemaRoleConfig: SchemaRoleConfig | undefined = options.agentConfig
			? {
				chainId: resolvedConfig.chain.id,
				rpcUrl: resolvedConfig.rpcUrl,
				privateKey: options.agentConfig.privateKey,
				pinataJwt: options.agentConfig.pinataJwt,
				registryOverrides: options.agentConfig.registryOverrides,
				subgraphOverrides: options.agentConfig.subgraphOverrides,
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
			config: resolvedConfig,
		});
	}

	getConfig(): AppConfig { return this.ctx.config; }
	getSchemaRegistry(): SchemaRegistry { return this.ctx.schemaRegistry; }
	getDatasourceRegistry(): DataSourceRegistry { return this.ctx.dataSourceRegistry; }
	getSettlementRegistry(): SettlementRegistry { return this.ctx.settlementRegistry; }
	getWalletClient(): WalletClient { return this.ctx.walletClient; }

	getAddress(): Hex {
		const address = this.ctx.walletClient.account?.address;
		if (!address) throw new Error("No account connected to wallet client");
		return address;
	}
}