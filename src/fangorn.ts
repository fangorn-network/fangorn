// fangorn.ts

import { Address, createPublicClient, Hex, http, WalletClient } from "viem";
import {
	Vault,
	DataSourceRegistry,
} from "./interface/datasource-registry/dataSourceRegistry.js";
import { Filedata, PendingEntry, VaultManifest } from "./types/index.js";
import StorageProvider from "./providers/storage/index.js";
import { AppConfig, FangornConfig } from "./config.js";
import { EncryptionService } from "./modules/encryption/index.js";
import { Gadget } from "./modules/gadgets/types.js";

/**
 *
 */
export class Fangorn {
	// data ingestion staging
	private pendingEntries: Map<string, PendingEntry> = new Map();

	constructor(
		private dataSourceRegistry: DataSourceRegistry,
		private walletClient: WalletClient,
		private storage: StorageProvider<any>,
		private encryptionService: EncryptionService,
		private domain: string,
	) {}

	public static async init(
		walletClient: WalletClient,
		storage: StorageProvider<any>,
		encryptionService: EncryptionService,
		domain: string,
		config?: AppConfig,
	): Promise<Fangorn> {
		const resolvedConfig = config || FangornConfig.ArbitrumSepolia;

		const publicClient = createPublicClient({
			transport: http(resolvedConfig.rpcUrl),
		});

		const dataSourceRegistry = new DataSourceRegistry(
			resolvedConfig.dataSourceRegistryContractAddress,
			publicClient as any,
			walletClient,
		);

		return new Fangorn(
			dataSourceRegistry,
			walletClient,
			storage,
			encryptionService,
			domain,
		);
	}

	/**
	 * Register a new named data source owned by the current wallet.
	 */
	async registerDataSource(name: string, agentId?: string): Promise<Hex> {
		return await this.dataSourceRegistry.registerDataSource(
			name,
			agentId || "",
		);
	}

	/**
	 * Upload files to a vault with the given gadget for access control.
	 */
	async upload(
		name: string,
		filedata: Filedata[],
		gadgetFactory: (file: Filedata) => Gadget | Promise<Gadget>,
		overwrite?: boolean,
	): Promise<string> {
		const who = this.walletClient.account.address;
		const datasource = await this.dataSourceRegistry.getDataSource(who, name);

		// Load existing manifest if appending
		if (datasource.manifestCid && !overwrite) {
			const oldManifest = await this.fetchManifest(datasource.manifestCid);
			this.loadManifest(oldManifest);

			try {
				await this.storage.delete(datasource.manifestCid);
			} catch (e) {
				console.warn("Failed to unpin old manifest:", e);
			}
		}

		// Add files with gadgets
		for (const file of filedata) {
			const gadget = await gadgetFactory(file);
			await this.addFile(file, gadget);
		}

		return await this.commit(name);
	}

	/**
	 * Encrypt and stage a single file.
	 * Call commitVault() after adding all files.
	 */
	async addFile(file: Filedata, gadget: Gadget): Promise<{ cid: string }> {
		const account = this.walletClient.account;
		if (!account?.address) throw new Error("Wallet not connected");

		// Encrypt using the gadget's access control
		const encrypted = await this.encryptionService.encrypt(file, gadget);

		// Upload ciphertext to storage
		const cid = await this.storage.store(encrypted, {
			metadata: { name: file.tag },
		});

		// Stage entry
		this.pendingEntries.set(file.tag, {
			tag: file.tag,
			cid,
			extension: file.extension,
			fileType: file.fileType,
			gadgetDescriptor: gadget.toDescriptor(),
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
	 * Commit all staged files to the vault.
	 */
	async commit(name: string): Promise<string> {
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
			metadata: { name: `manifest-${name}` },
		});

		const hash = await this.dataSourceRegistry.updateDataSource(
			name,
			manifestCid,
		);
		await this.dataSourceRegistry.waitForTransaction(hash);

		this.pendingEntries.clear();
		return manifestCid;
	}

	/**
	 * Decrypt a file from a vault.
	 */
	async decryptFile(
		owner: Address,
		name: string,
		tag: string,
		authContext?: any,
	): Promise<Uint8Array> {
		// Fetch manifest and find entry
		const vault = await this.dataSourceRegistry.getDataSource(owner, name);
		const manifest = await this.storage.retrieve(vault.manifestCid);

		const entry = manifest.entries.find((e: any) => e.tag === tag);
		if (!entry) {
			throw new Error(`Entry not found: ${tag}`);
		}

		// Fetch encrypted payload
		const encrypted = await this.storage.retrieve(entry.cid);

		// Decrypt via encryption service
		const resolvedAuthContext =
			authContext ??
			(await this.encryptionService.createAuthContext(
				this.walletClient,
				this.domain,
			));

		const decrypted = await this.encryptionService.decrypt(
			encrypted,
			resolvedAuthContext,
		);

		return decrypted.data;
	}

	// Read operations

	// fetch the data source info
	async getDataSource(owner: Address, name: string): Promise<Vault> {
		return await this.dataSourceRegistry.getDataSource(owner, name);
	}

	registry(): DataSourceRegistry {
		return this.dataSourceRegistry;
	}

	// Get the manifest for a given data source
	async getManifest(
		owner: Address,
		name: string,
	): Promise<VaultManifest | undefined> {
		const vault = await this.getDataSource(owner, name);
		if (!vault.manifestCid || vault.manifestCid === "") {
			return undefined;
		}
		return await this.fetchManifest(vault.manifestCid);
	}

	// attempt to get specific data from the data source
	async getDataSourceData(owner: Address, name: string, tag: string) {
		const manifest = await this.getManifest(owner, name);
		if (!manifest) {
			throw new Error("Vault has no manifest");
		}
		const entry = manifest.entries.find((e) => e.tag === tag);
		if (!entry) {
			throw new Error(`Entry not found: ${tag}`);
		}
		return entry;
	}

	getAddress(): Hex {
		const account = this.walletClient.account;
		if (!account?.address) throw new Error("Wallet not connected");
		return account.address;
	}

	async fetchManifest(cid: string): Promise<VaultManifest> {
		return (await this.storage.retrieve(cid)) as unknown as VaultManifest;
	}

	// helpers

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
