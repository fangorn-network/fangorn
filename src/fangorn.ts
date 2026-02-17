// fangorn.ts

import {
	Address,
	createPublicClient,
	encodeAbiParameters,
	Hex,
	http,
	keccak256,
	parseAbiParameters,
	WalletClient,
} from "viem";
import {
	Vault,
	DataSourceRegistry,
} from "./interface/datasource-registry/dataSourceRegistry.js";
import { Filedata, PendingEntry, VaultManifest } from "./types/index.js";
import StorageProvider from "./providers/storage/index.js";
import { AppConfig, FangornConfig } from "./config.js";
import { EncryptionService } from "./modules/encryption/index.js";
import { LitEncryptionService } from "./modules/encryption/lit.js";
import { Predicate } from "./modules/predicates/types.js";

/**
 * Fangorn - Encrypted vault management with pluggable access control
 *
 * Core responsibilities:
 * - Vault lifecycle (register, upload, commit)
 * - Manifest management
 * - Coordinating encryption/decryption via predicates
 *
 * NOT responsible for:
 * - Specific access control logic (that's predicates)
 * - Payment/settlement (that's x402f)
 */
export class Fangorn {
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
	async registerDataSource(name: string): Promise<Hex> {
		return await this.dataSourceRegistry.registerDataSource(name);
	}

	/**
	 * Upload files to a vault with the given predicate for access control.
	 */
	async upload(
		name: string,
		filedata: Filedata[],
		predicateFactory: (file: Filedata) => Predicate | Promise<Predicate>,
		overwrite?: boolean,
	): Promise<string> {
		const who = this.walletClient.account.address;
		const id = deriveDatasourceId(name, who);
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

		// Add files with predicates
		for (const file of filedata) {
			const predicate = await predicateFactory(file);
			await this.addFile(file, predicate);
		}

		return await this.commit(name);
	}

	/**
	 * Encrypt and stage a single file. Call commitVault() after adding all files.
	 */
	async addFile(
		file: Filedata,
		predicate: Predicate,
	): Promise<{ cid: string }> {
		const account = this.walletClient.account;
		if (!account?.address) throw new Error("Wallet not connected");

		// Encrypt using the predicate's access control
		const encrypted = await this.encryptionService.encrypt(file, predicate);

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
			predicateDescriptor: predicate.toDescriptor(),
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
				predicateDescriptor: e.predicateDescriptor,
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

	// --- Read operations ---

	// fetch the data source info
	async getDataSource(owner: Address, name: string): Promise<Vault> {
		return await this.dataSourceRegistry.getDataSource(owner, name);
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

	// --- Private ---

	private loadManifest(oldManifest: VaultManifest): void {
		for (const entry of oldManifest.entries) {
			this.pendingEntries.set(entry.tag, {
				tag: entry.tag,
				cid: entry.cid,
				extension: entry.extension,
				fileType: entry.fileType,
				predicateDescriptor: entry.predicateDescriptor,
			});
		}
	}
}

export function deriveDatasourceId(name: string, owner: Address): Hex {
	return keccak256(
		encodeAbiParameters(parseAbiParameters("string, address"), [name, owner]),
	);
}

// import { createSiweMessage } from "@lit-protocol/auth-helpers";
// import {
// 	LitAccessControlConditionResource,
// 	LitActionResource,
// 	LitPKPResource,
// } from "@lit-protocol/auth-helpers";

// import { LitClient } from "@lit-protocol/lit-client";
// import { createAccBuilder } from "@lit-protocol/access-control-conditions";
// import {
// 	createPublicClient,
// 	Hex,
// 	http,
// 	WalletClient,
// } from "viem";
// import { Vault, DataSourceRegistry } from "./interface/datasource-registry/dataSourceRegistry.js";
// import { Filedata, PendingEntry, VaultManifest } from "./types/index.js";
// import { decryptData, encryptData } from "./modules/encryption/aes.js";
// import { createAuthManager, storagePlugins } from "@lit-protocol/auth";
// import StorageProvider from "./providers/storage/index.js";
// import { AppConfig, FangornConfig } from "./config.js";
// import { computeTagCommitment, fieldToHex } from "./utils/index.js";
// import { PredicateBuilder, predicates } from "./modules/predicates/builder.js";
// import { PaymentPredicate } from "./modules/predicates/payment.js";
// import { SettlementTracker } from "./interface/settlement-tracker/settlementTracker.js";

// const litActionCode = (chainName: string) => `(async () => {
//     try {
//         const decryptedContent = await Lit.Actions.decryptAndCombine({
//             accessControlConditions: jsParams.accessControlConditions,
//             ciphertext: jsParams.ciphertext,
//             dataToEncryptHash: jsParams.dataToEncryptHash,
//             authSig: jsParams.authSig,
//             chain: "${chainName}",
//         });
//         Lit.Actions.setResponse({
//             response: decryptedContent,
//             success: true,
//         });
//     } catch (error) {
//         Lit.Actions.setResponse({
//             response: error.message,
//             success: false,
//         });
//     }
// })();`;

// /**
//  * Fangorn class
//  */
// export class Fangorn {

// 	// private predicateBuilder: PredicateBuilder;

// 	// The name (for LIT) of the chain we are using
// 	private chainName: string;
// 	// The LIT client for interacting with the LIT network
// 	private litClient: LitClient;
// 	// The CID of the lit action in storage
// 	private litActionCid: string;

// 	// The dataSourceRegistry Contract instance
// 	private dataSourceRegistry: DataSourceRegistry;
// //
// 	private settlementTracker: SettlementTracker;

// 	// The wallet client for signing txs
// 	private walletClient: WalletClient;
// 	// The storage layer (todo: make this into a generic storage adapter)
// 	private storage: StorageProvider<any>;
// 	// in-mem state for building manifests
// 	private pendingEntries: Map<string, PendingEntry> = new Map();
// 	// The domain (i.e. webserver address) that is using the Fangorn Client
// 	private domain: string;

// 	constructor(
// 		chainName: string,
// 		litActionCid: string,
// 		litClient: LitClient,
// 		dataSourceRegistry: DataSourceRegistry,
// 		walletClient: WalletClient,
// 		storage: StorageProvider<any>,
// 		domain: string,
// 	) {
// 		this.litClient = litClient;
// 		this.dataSourceRegistry = dataSourceRegistry;
// 		this.walletClient = walletClient;
// 		this.storage = storage;
// 		this.litActionCid = litActionCid;
// 		this.chainName = chainName;
// 		this.domain = domain;

// 		// this.predicateBuilder = predicates({
// 		// 	chainName,
// 		// 	contractAddress: dataSourceRegistry,
// 		// });
// 	}

// 	public static async init(
// 		walletClient: WalletClient,
// 		storage: StorageProvider<any>,
// 		litClient: any,
// 		domain: string,
// 		config?: AppConfig | undefined,
// 	) {
// 		// defaults to arbitrum sepolia
// 		const resolvedConfig = config || FangornConfig.ArbitrumSepolia;
// 		const rpcUrl = resolvedConfig.rpcUrl;
// 		const chainName = resolvedConfig.chainName;

// 		// TODO: should this be made outside of the client?
// 		const publicClient = createPublicClient({ transport: http(rpcUrl) });

// 		// interacts with the zk-gate contract
// 		let dataSourceRegistryClient = new DataSourceRegistry(
// 			resolvedConfig.dataSourceRegistryContractAddress,
// 			publicClient as any,
// 			walletClient,
// 		);

// 		return new Fangorn(
// 			chainName,
// 			resolvedConfig.litActionCid,
// 			litClient,
// 			dataSourceRegistryClient,
// 			walletClient,
// 			storage,
// 			domain,
// 		);
// 	}

// 	/**
// 	 * Register a new named data source owned by the current wallet provider.
// 	 * Data source names must be unique.
// 	 * @param name The datasource name
// 	 * @returns The datasource id
// 	 */
// 	async registerDataSource(name: string): Promise<Hex> {
// 		const id = await this.dataSourceRegistry.registerDataSource(name);
// 		return id;
// 	}

// 	/**
// 	 * Upload data to an existing vault
// 	 * @param id The id of the datasource being modified
// 	 * @param filedata The file data to insert
// 	 * @param overwrite If true, then overwrite the existing vault with new files
// 	 * @returns The new manifest CID and Merkle root
// 	 */
// 	async upload(id: Hex, filedata: Filedata[], overwrite?: boolean) {
// 		// check if manifest exists or not
// 		// load existing manifest
// 		const vault = await this.dataSourceRegistry.getDataSource(id);
// 		// if the manifest exists and we don't want to overwrite
// 		if (vault.manifestCid && !overwrite) {
// 			const oldManifest = await this.fetchManifest(vault.manifestCid);
// 			await this.loadManifest(oldManifest);
// 			// try to unpin old manifest
// 			try {
// 				await this.storage.delete(vault.manifestCid);
// 			} catch (e) {
// 				console.warn("Failed to unpin old manifest:", e);
// 			}
// 		}

// 		// add files
// 		for (let file of filedata) {
// 			await this.addFile(id, file);
// 		}
// 		return await this.commitVault(id);
// 	}

// 	/**
// 	 * Encrypts data (with LIT) and uploads ciphertext to IPFS.
// 	 * Does NOT update the vault!! You must call commitVault() after adding all files.
// 	 */
// 	async addFile(id: Hex, file: Filedata): Promise<{ cid: string }> {
// 		// get the payTo address, error if not defined
// 		const account = this.walletClient.account;
// 		if (!account?.address) throw new Error("Wallet not connected");

// 		// compute commitment to (id, tag)
// 		const tag = file.tag;
// 		const commitment = await computeTagCommitment(id, tag);
// 		const commitmentHex = fieldToHex(commitment);

// 		const predicate = new PaymentPredicate(
// 			{ commitment: commitmentHex,
// 				chainName: this.chainName,
// 				settlementTrackerContractAddress: this.settlementTrackerContractAddress
// 			},
// 			 this.storage
// 		)

// 		// encrypt(file, new PaymentPredicate(...));
// 		// const ciphertext = await encrypt(file, );

// 		// encrypt the actual file contents using AES-GCM locally
// 		// with a random ephemeral secret key
// 		// const { encryptedData, keyMaterial } = await encryptData(file.data);
// 		// const keyAsString = keyMaterial.toString();

// 		// idea: the user specifies a set of predicates
// 		// we map this to a lit action
// 		// starting with one predicate: payment

// 		// // build ACC
// 		// const acc = createAccBuilder()
// 		// 	.requireLitAction(
// 		// 		this.litActionCid, // <--- and this lit action could technically be anything!
// 		// 		"go",
// 		// 		[
// 		// 			this.chainName,
// 		// 			this.dataSourceRegistry.getContractAddress(), // <--- ok so this is actually the settlement tracker
// 		// 			commitmentHex,
// 		// 		],
// 		// 		"true",
// 		// 	)
// 		// 	.build();
// 		// encrypt the KEY with Lit
// 		const keyEncryptedData = await this.litClient.encrypt({
// 			dataToEncrypt: keyAsString,
// 			unifiedAccessControlConditions: acc,
// 			chain: this.chainName,
// 		});
// 		// upload ciphertext to storage (i.e. pin to IPFS)
// 		const upload = await this.storage.store(
// 			{ encryptedData, keyEncryptedData, acc },
// 			{ metadata: { name: tag } },
// 		);

// 		// stage the entry (not committed yet)
// 		this.pendingEntries.set(tag, {
// 			tag,
// 			cid: upload,
// 			price: file.price,
// 			acc,
// 			extension: file.extension,
// 			fileType: file.fileType,
// 		});

// 		return { cid: upload };
// 	}

// 	/**
// 	 * Removes a file from staging (call before committing)
// 	 * @param tag The tag of the file
// 	 * @returns bool
// 	 */
// 	removeFile(tag: string): boolean {
// 		return this.pendingEntries.delete(tag);
// 	}

// 	/**
// 	 * Builds manifest from all staged files and updates the vault on-chain.
// 	 * Call this *after* adding all files with addFile().
// 	 */
// 	async commitVault(id: Hex): Promise<string> {
// 		if (this.pendingEntries.size === 0) throw new Error("No files to commit");

// 		const entries = Array.from(this.pendingEntries.values());

// 		// Construct manifest
// 		const manifest: VaultManifest = {
// 			version: 1,
// 			entries: entries.map((e, i) => ({
// 				tag: e.tag,
// 				cid: e.cid,
// 				price: e.price,
// 				index: i,
// 				extension: e.extension,
// 				fileType: e.fileType,
// 			})),
// 			tree: [],
// 		};

// 		// pin manifest to IPFS
// 		const manifestUpload = await this.storage.store(manifest, {
// 			metadata: { name: `manifest-${id}` },
// 		});

// 		// update datasource registry
// 		const hash = await this.dataSourceRegistry.updateDataSource(
// 			id,
// 			manifestUpload,
// 		);
// 		await this.dataSourceRegistry.waitForTransaction(hash);
// 		// clear staging
// 		this.pendingEntries.clear();

// 		return manifestUpload;
// 	}

// 	/**
// 	 * Loads existing manifest
// 	 */
// 	async loadManifest(oldManifest: any) {
// 		// load existing entries into pending
// 		for (const entry of oldManifest.entries) {
// 			this.pendingEntries.set(entry.tag, {
// 				tag: entry.tag,
// 				cid: entry.cid,
// 				price: entry.price,
// 				// leaf: hexToField(entry.leaf),
// 				// commitment: entry.commitment as Hex,
// 				acc: null,
// 				extension: entry.extension,
// 				fileType: entry.fileType,
// 			});
// 		}
// 	}

// 	// // build and sign the transferwithAuthorization call that we will pass to the facilitator
// 	// // TODO: Move this out of here, should be in x402f lib
// 	// public async pay(
// 	// 	id: Hex,
// 	// 	tag: string,
// 	// 	to: Address,
// 	// 	auth: {
// 	// 		from: Address;
// 	// 		amount: bigint;
// 	// 		validAfter: bigint;
// 	// 		validBefore: bigint;
// 	// 		nonce: Hex;
// 	// 		signature: Hex;
// 	// 	},
// 	// ) {
// 	// 	const commitment = await computeTagCommitment(id, tag);
// 	// 	const commitmentHex = fieldToHex(commitment);
// 	// 	const { v, r, s } = parseSignature(auth.signature);

// 	// 	return await this.dataSourceRegistry.pay({
// 	// 		commitment: commitmentHex,
// 	// 		from: auth.from,
// 	// 		to: to,
// 	// 		value: auth.amount,
// 	// 		validAfter: auth.validAfter,
// 	// 		validBefore: auth.validBefore,
// 	// 		nonce: auth.nonce,
// 	// 		v: Number(v),
// 	// 		r,
// 	// 		s,
// 	// 	});
// 	// }

// 	/**
// 	 * Attempt to decrypt data identified with a given tag within the given vault
// 	 * @param id
// 	 * @param tag
// 	 * @param password
// 	 * @returns
// 	 */
// 	async decryptFile(
// 		id: Hex,
// 		tag: string,
// 		authContext?: any,
// 	): Promise<Uint8Array<ArrayBufferLike>> {
// 		// load the auth context: if it's not present then assume this is running in a node env
// 		if (!authContext) {
// 			const account = this.walletClient.account!;
// 			const authManager = createAuthManager({
// 				storage: storagePlugins.localStorageNode({
// 					appName: "fangorn",
// 					networkName: "naga-dev",
// 					storagePath: "./lit-auth-storage",
// 				}),
// 			});

// 			const litClient = this.litClient;
// 			authContext = await authManager.createEoaAuthContext({
// 				litClient,
// 				config: { account: account },
// 				authConfig: {
// 					domain: this.domain,
// 					statement: "Recover key.",
// 					// is this the right duration for expiry?
// 					expiration: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(),
// 					// Are resources too open?
// 					resources: [
// 						["access-control-condition-decryption", "*"],
// 						["lit-action-execution", "*"],
// 						["pkp-signing", "*"],
// 					],
// 				},
// 			});
// 		}

// 		const resources = [
// 			{
// 				resource: new LitAccessControlConditionResource("*"),
// 				ability: "access-control-condition-decryption" as const,
// 			},
// 			{
// 				resource: new LitActionResource("*"),
// 				ability: "lit-action-execution" as const,
// 			},
// 			{
// 				resource: new LitPKPResource("*"),
// 				ability: "pkp-signing" as const,
// 			},
// 		];

// 		const siweMessage = await createSiweMessage({
// 			walletAddress: this.walletClient.account.address,
// 			domain: "localhost",
// 			statement: "Decrypt data",
// 			uri: "https://localhost",
// 			version: "1",
// 			chainId: 1,
// 			expiration: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(),
// 			resources,
// 			nonce: Date.now().toString(),
// 		});

// 		// Sign it directly
// 		const signature = await this.walletClient.signMessage({
// 			message: siweMessage,
// 			account: this.walletClient.account,
// 		});

// 		// Build the authSig object
// 		const directAuthSig = {
// 			sig: signature,
// 			derivedVia: "web3.eth.personal.sign",
// 			signedMessage: siweMessage,
// 			address: this.walletClient.account.address,
// 		};

// 		// fetch manifest
// 		const vault = await this.dataSourceRegistry.getDataSource(id);
// 		const manifest = await this.storage.retrieve(vault.manifestCid);

// 		// try to find entry
// 		const entry = manifest.entries.find((e) => e.tag === tag);
// 		if (!entry) {
// 			throw new Error(`Entry not found: ${tag}`);
// 		}

// 		// fetch ciphertext
// 		const response = await this.storage.retrieve(entry.cid);
// 		const { encryptedData, keyEncryptedData, acc } = response as any;

// 		try {
// 			const result = await this.litClient.executeJs({
// 				code: litActionCode(this.chainName),
// 				authContext,
// 				jsParams: {
// 					accessControlConditions: acc,
// 					ciphertext: keyEncryptedData.ciphertext,
// 					dataToEncryptHash: keyEncryptedData.dataToEncryptHash,
// 					authSig: directAuthSig,
// 				},
// 			});

// 			const key = Uint8Array.from(
// 				// to make sure the first digit doesn't get ignored an coverted to a 0
// 				(result.response as string)
// 					// 1. Strip any non-digits from the very start (BOM, [, ", etc.)
// 					.replace(/^[^\d]+/, "")
// 					.split(","),
// 				(entry) => {
// 					const val = parseInt(entry.trim(), 10);
// 					// 2. Safety check for malformed segments
// 					return isNaN(val) ? 0 : val;
// 				},
// 			);

// 			// actually decrypt the data with the recovered key
// 			const decryptedFile = await decryptData(
// 				encryptedData,
// 				key as Uint8Array<ArrayBuffer>,
// 			);

// 			return decryptedFile;
// 		} catch (error) {
// 			console.error(error);
// 		}

// 		return new Uint8Array();
// 	}

// 	/**
// 	 * Get vault data from the contract
// 	 * @param id
// 	 * @param tag
// 	 * @returns
// 	 */
// 	public async getDataSourceData(id: Hex, tag: string) {
// 		// fetch manifest from pinata
// 		const vault = await this.getDataSource(id);
// 		const manifest = await this.fetchManifest(vault.manifestCid);
// 		// try to find entry
// 		const entry = manifest.entries.find((e) => e.tag === tag);
// 		if (!entry) {
// 			throw new Error(`Entry not found: ${tag}`);
// 		}
// 		//   return entry;
// 		return entry;
// 	}

// 	/**
// 	 * Get the manifest from the chain
// 	 */
// 	public async getManifest(id: Hex) {
// 		// fetch manifest from pinata
// 		const vault = await this.getDataSource(id);

// 		if (!vault.manifestCid || vault.manifestCid == "") {
// 			return;
// 		}
// 		return await this.fetchManifest(vault.manifestCid);
// 	}

// 	/**
// 	 * Get the contract address
// 	 * @returns
// 	 */
// 	getAddress() {
// 		const account = this.walletClient.account;
// 		if (!account?.address) throw new Error("Wallet not connected");
// 		return account.address;
// 	}

// 	// Read the data source metadata
// 	public async getDataSource(id: Hex): Promise<Vault> {
// 		const vault: Vault = await this.dataSourceRegistry.getDataSource(id);
// 		return vault;
// 	}

// 	/**
// 	 * fetch raw manifest data from storage
// 	 * @param cid
// 	 * @returns
// 	 */
// 	public async fetchManifest(cid: string): Promise<VaultManifest> {
// 		const response = await this.storage.retrieve(cid);
// 		return response as unknown as VaultManifest;
// 	}
// }
