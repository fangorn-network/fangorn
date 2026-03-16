import { Address, createPublicClient, Hex, http, PublicClient, WalletClient } from "viem";
import { DataSourceRegistry } from "./interface/datasource-registry/dataSourceRegistry.js";
import { Filedata, PendingEntry, VaultEntry, VaultManifest } from "./types/index.js";
import StorageProvider from "./providers/storage/index.js";
import { AppConfig, FangornConfig } from "./config.js";
import { AuthContext, EncryptionService } from "./modules/encryption/index.js";
import { Gadget } from "./modules/gadgets/types.js";
import { EncryptedPayload } from "./modules/encryption/types.js";
import { SchemaRegistry } from "./interface/schema-registry/index.js";
import { RegisterParams, SettlementRegistry, SettleParams } from "./interface/settlement-registry/index.js";
import { Identity } from "@semaphore-protocol/identity";

export class Fangorn {
	private pendingEntries = new Map<string, PendingEntry>();

	constructor(
		private dataSourceRegistry: DataSourceRegistry,
		private schemaRegistry: SchemaRegistry,
		private settlementRegistry: SettlementRegistry,
		private walletClient: WalletClient,
		private storage: StorageProvider<unknown>,
		private encryptionService: EncryptionService,
		private domain: string,
	) { }

	/**
	 * Initialize the Fangorn lib
	 * 
	 * @param walletClient 
	 * @param storage 
	 * @param encryptionService 
	 * @param domain 
	 * @param config 
	 * @returns 
	 */
	public static init(
		walletClient: WalletClient,
		storage: StorageProvider<unknown>,
		encryptionService: EncryptionService,
		domain: string,
		config?: AppConfig,
	): Fangorn {
		const resolvedConfig = config ?? FangornConfig.ArbitrumSepolia;

		const publicClient = createPublicClient({
			transport: http(resolvedConfig.rpcUrl),
		}) as PublicClient;

		// build the registry contract interfaces
		const dataSourceRegistry = new DataSourceRegistry(
			resolvedConfig.dataSourceRegistryContractAddress,
			publicClient,
			walletClient,
		);

		const schemaRegistry = new SchemaRegistry(
			resolvedConfig.schemaRegistryContractAddress,
			publicClient,
			walletClient,
		);

		const settlementRegistry = new SettlementRegistry(
			resolvedConfig.settlementRegistryContractAddress,
			publicClient,
			walletClient,
		);

		return new Fangorn(
			dataSourceRegistry,
			schemaRegistry,
			settlementRegistry,
			walletClient,
			storage,
			encryptionService,
			domain,
		);
	}

	/**
 * Phase 1: Buyer pays and registers a Semaphore identity for a resource.
 * Derives resource_id from (owner, schemaId, tag) automatically.
 * Await confirmation before calling settle().
 */
	async register(
		owner: Address,
		schemaId: Hex,
		tag: string,
		params: Omit<RegisterParams, "resourceId">,
	): Promise<Hex> {
		const resourceId = SettlementRegistry.deriveResourceId(owner, schemaId, tag);
		return this.settlementRegistry.register({ resourceId, ...params });
	}

	/**
	 * Phase 2: Prove group membership and claim access.
	 * Fires the hook (NFT mint, timelock, etc.) atomically.
	 * Call after register() tx is confirmed.
	 */
	async settle(
		owner: Address,
		schemaId: Hex,
		tag: string,
		params: Omit<SettleParams, "resourceId">,
	): Promise<Hex> {
		const resourceId = SettlementRegistry.deriveResourceId(owner, schemaId, tag);
		return this.settlementRegistry.settle({ resourceId, ...params });
	}


	/**
	 * Upload files and publish a manifest under a specific schema.
	 * Loads and merges the existing manifest for that schema unless overwrite is true.
	 * 
	 * Also ensures a SettlementRegistry resource exists for each (owner, schemaId, tag)
	 * so buyers can register and settle against it.
	 */
	async upload(
		filedata: Filedata[],
		gadgetFactory: (file: Filedata) => Gadget | Promise<Gadget>,
		schemaId: Hex,
		overwrite?: boolean,
	): Promise<string> {
		const account = this.walletClient.account;
		if (!account) throw new Error("No account found in wallet client");

		if (!overwrite) {
			try {
				const existing = await this.dataSourceRegistry.getManifest(account.address, schemaId);
				if (existing.manifestCid) {
					const oldManifest = await this.fetchManifest(existing.manifestCid);
					this.loadManifest(oldManifest);
					try {
						await this.storage.delete(existing.manifestCid);
					} catch (e) {
						console.warn("Failed to unpin old manifest:", e);
					}
				}
			} catch {
				// no existing manifest for this schema, first publish
			}
		}

		for (const file of filedata) {
			const gadget = await gadgetFactory(file);
			await this.addFile(file, gadget);
		}

		return await this.commit(schemaId);
	}

	/**
	 * Encrypt and stage a single file.
	 * Call commit() after staging all files.
	 */
	async addFile(file: Filedata, gadget: Gadget): Promise<{ cid: string }> {
		const account = this.walletClient.account;
		if (!account?.address) throw new Error("Wallet not connected");

		const encrypted = await this.encryptionService.encrypt(file, gadget);
		const cid = await this.storage.store(encrypted, {
			metadata: { name: file.tag },
		});

		const gadgetDescriptor = await gadget.toDescriptor();

		this.pendingEntries.set(file.tag, {
			tag: file.tag,
			cid,
			extension: file.extension,
			fileType: file.fileType,
			gadgetDescriptor,
		});

		return { cid };
	}

	/**
	 * Remove a staged file before committing.
	 */
	removeFile(tag: string): boolean {
		return this.pendingEntries.delete(tag);
	}

	/**
	 * Serialize staged files into a manifest, pin it, and publish on-chain under the given schema.
	 */
	async commit(schemaId: Hex): Promise<string> {
		if (this.pendingEntries.size === 0) {
			throw new Error("No files to commit");
		}

		const entries = Array.from(this.pendingEntries.values());

		const manifest: VaultManifest = {
			version: 1,
			entries: entries.map((e, i) => ({
				tag: e.tag,
				cid: e.cid,
				index: i,
				extension: e.extension,
				fileType: e.fileType,
				gadgetDescriptor: e.gadgetDescriptor,
			})),
			tree: [],
		};

		const manifestCid = await this.storage.store(manifest, {
			metadata: { name: "manifest" },
		});

		await this.dataSourceRegistry.publishManifest(manifestCid, schemaId);

		this.pendingEntries.clear();
		return manifestCid;
	}

	/**
	 * Decrypt a file from an owner's manifest under a specific schema, by tag.
	 */
	async decryptFile(
		owner: Address,
		schemaId: Hex,
		tag: string,
		options?: {
			identity?: Identity;
			// default: true
			requireSettlement?: boolean;  
			authContext?: AuthContext;
		},
	): Promise<Uint8Array> {
		const requireSettlement = options?.requireSettlement ?? true;

		if (requireSettlement) {
			if (!options?.identity) throw new Error("identity required to verify settlement");
			const resourceId = SettlementRegistry.deriveResourceId(owner, schemaId, tag);
			const registered = await this.settlementRegistry.isRegistered(
				resourceId,
				options.identity.commitment,
			);
			if (!registered) throw new Error("Access denied: identity not registered for this resource");
		}

		const manifest = await this.getManifest(owner, schemaId);
		if (!manifest) throw new Error("No manifest found for owner + schema");

		const entry = manifest.entries.find((e: VaultEntry) => e.tag === tag);
		if (!entry) throw new Error(`Entry not found: ${tag}`);

		const encrypted = await this.storage.retrieve(entry.cid) as EncryptedPayload;

		const resolvedAuthContext =
			options?.authContext ??
			(await this.encryptionService.createAuthContext(this.walletClient, this.domain));

		const decrypted = await this.encryptionService.decrypt(encrypted, resolvedAuthContext);
		return decrypted.data;
	}

	/**
	 * Fetch and deserialize the manifest for a given (owner, schemaId) pair.
	 */
	async getManifest(owner: Address, schemaId: Hex): Promise<VaultManifest | undefined> {
		try {
			const ds = await this.dataSourceRegistry.getManifest(owner, schemaId);
			if (!ds.manifestCid || ds.manifestCid === "") return undefined;
			return await this.fetchManifest(ds.manifestCid);
		} catch {
			return undefined;
		}
	}

	/**
	 * Get a specific entry from an owner's manifest under a schema, by tag.
	 */
	async getEntry(owner: Address, schemaId: Hex, tag: string): Promise<VaultEntry> {
		const manifest = await this.getManifest(owner, schemaId);
		if (!manifest) throw new Error("No manifest found for owner + schema");
		const entry = manifest.entries.find((e) => e.tag === tag);
		if (!entry) throw new Error(`Entry not found: ${tag}`);
		return entry;
	}

	getAddress(): Hex {
		const account = this.walletClient.account;
		if (!account?.address) throw new Error("Wallet not connected");
		return account.address;
	}

	async fetchManifest(cid: string): Promise<VaultManifest> {
		return (await this.storage.retrieve(cid)) as VaultManifest;
	}

	/**
	 * Get the configured Datasource Registry
	 * @returns DatasourceRegistry
	 */
	getDatasourceRegistry(): DataSourceRegistry {
		return this.dataSourceRegistry;
	}

	/**
	 * Get the configured Schema Registry
	 * @returns SchemaRegistry
	 */
	getSchemaRegistry(): SchemaRegistry {
		return this.schemaRegistry;
	}

	/**
	 * Get the configured settlement registry
	 * @returns SettlementRegistry
	 */
	getSettlementRegistry(): SettlementRegistry {
		return this.settlementRegistry;
	}

	getWalletClient(): WalletClient {
		return this.walletClient;
	}

	private loadManifest(oldManifest: VaultManifest): void {
		for (const entry of oldManifest.entries) {
			this.pendingEntries.set(entry.tag, {
				tag: entry.tag,
				cid: entry.cid,
				extension: entry.extension,
				fileType: entry.fileType,
				gadgetDescriptor: entry.gadgetDescriptor,
			});
		}
	}
}