import { LitClient } from "@lit-protocol/lit-client";
import { createAccBuilder } from "@lit-protocol/access-control-conditions";
import { nagaDev } from "@lit-protocol/networks";
import {
	Address,
	createPublicClient,
	Hex,
	http,
	parseSignature,
	WalletClient,
} from "viem";
import { Vault, ContentRegistry } from "./interface/contentRegistry.js";
import { computeTagCommitment } from "./crypto/proof.js";
import {
	fieldToHex, // could be a util func instead
} from "./crypto/merkle.js";
import { Filedata, PendingEntry, VaultManifest } from "./types/types.js";
import { decryptData, encryptData } from "./crypto/encryption.js";
import { createAuthManager, storagePlugins } from "@lit-protocol/auth";
import StorageProvider from "./providers/storage/index.js";

export interface AppConfig {
	// The CID pointing to the expected LIT action
	litActionCid: string;
	// The CID pointing to the compiled circuit json
	// circuitJsonCid: string;
	// The deployed contentRegistry contract address
	contentRegistryContractAddress: Hex;
	// The name of the chain for LIT action execution (does not always match what is defined by viem)
	chainName: string;
	// The public rpc address of the chain we are connecting to
	rpcUrl: string;
	usdcContractAddress: Hex;
}

export namespace FangornConfig {
	// A testnet config for cotnracts deployed on Base Sepolia
	export const Testnet: AppConfig = {
		litActionCid: "QmP77ECWeWZPe8dsBTBG1HmpxBzkKX5D9k3v8txeEm8uFx",
		// circuitJsonCid: "QmXw1rWUC2Kw52Qi55sfW3bCR7jheCDfSUgVRwvsP8ZZPE",
		usdcContractAddress: "0x0",
		contentRegistryContractAddress:
			"0xc061f4e1422363a27f1b05bf65b644b29e3cec7c",
		chainName: "baseSepolia",
		rpcUrl: "https://sepolia.base.org",
	};
}

/**
 * Fangorn class
 */
export class Fangorn {
	// The name (for LIT) of the chain we are using
	private chainName: string;
	// The LIT client for interacting with the LIT network
	private litClient: LitClient;
	// The CID of the lit action in storage
	private litActionCid: string;
	// The complied noir circuit (e.g. circuit.json)
	// private circuit: CompiledCircuit;
	// The ContentRegistry Contract instance
	private contentRegistry: ContentRegistry;
	// The wallet client for signing txs
	private walletClient: WalletClient;
	// The storage layer (todo: make this into a genericc storage adapter)
	private storage: StorageProvider<any>;
	// private pinata: PinataSDK;
	// in-mem state for building manifests
	private pendingEntries: Map<string, PendingEntry> = new Map();
	// The domain (i.e. webserver address) that is using the Fangorn Client
	private domain: string;

	constructor(
		chainName: string,
		litActionCid: string,
		// circuit: CompiledCircuit,
		litClient: any,
		contentRegistry: any,
		walletClient: WalletClient,
		storage: StorageProvider<any>,
		domain: string,
	) {
		this.litClient = litClient;
		this.contentRegistry = contentRegistry;
		this.walletClient = walletClient;
		this.storage = storage;
		this.litActionCid = litActionCid;
		// this.circuit = circuit;
		this.chainName = chainName;
		this.domain = domain;
	}

	public static async init(
		walletClient: WalletClient,
		storage: StorageProvider<any>,
		litClient: any,
		domain: string,
		config?: AppConfig | undefined,
	) {
		const resolvedConfig = config || FangornConfig.Testnet;
		const rpcUrl = resolvedConfig.rpcUrl;
		const chainName = resolvedConfig.chainName;

		// TODO: should this be made outside of the client?
		const publicClient = createPublicClient({ transport: http(rpcUrl) });

		// interacts with the zk-gate contract
		let contentRegistryClient = new ContentRegistry(
			resolvedConfig.contentRegistryContractAddress,
			publicClient as any,
			walletClient,
		);

		// // read the circuit from ipfs
		// // TODO: assumes the circuit exists, no error handling here
		// const circuitResponse = await pinata.gateways.public.get(
		// 	resolvedConfig.circuitJsonCid,
		// );
		// const compiledCircuit = circuitResponse.data as unknown as CompiledCircuit;

		return new Fangorn(
			chainName,
			resolvedConfig.litActionCid,
			// compiledCircuit,
			litClient,
			contentRegistryClient,
			walletClient,
			storage,
			domain,
		);
	}

	async registerDataSource(name: string): Promise<Hex> {
		// const fee = await this.contentRegistry.getVaultCreationFee();
		const { hash: createHash, vaultId } =
			await this.contentRegistry.createVault(name);
		return vaultId;
	}

	/**
	 * Upload data to an existing vault
	 * @param vaultId The id of the vault being modified
	 * @param filedata The file data to insert
	 * @param overwrite If true, then overwrite the existing vault with new files
	 * @returns The new manifest CID and Merkle root
	 */
	async upload(vaultId: Hex, filedata: Filedata[], overwrite?: boolean) {
		// check if manifest exists or not
		// load existing manifest
		const vault = await this.contentRegistry.getVault(vaultId);
		// if the manifest exists and we don't want to overwrite
		if (vault.manifestCid && !overwrite) {
			const oldManifest = await this.fetchManifest(vault.manifestCid);
			await this.loadManifest(oldManifest);
			// try to unpin old manifest
			try {
				await this.storage.delete(vault.manifestCid);
			} catch (e) {
				console.warn("Failed to unpin old manifest:", e);
			}
		}

		// add files
		for (let file of filedata) {
			await this.addFile(vaultId, file);
		}
		return await this.commitVault(vaultId);
	}

	/**
	 * Encrypts data (with LIT) and uploads ciphertext to IPFS.
	 * Does NOT update the vault!! You must call commitVault() after adding all files.
	 */
	async addFile(vaultId: Hex, file: Filedata): Promise<{ cid: string }> {
		// get the payTo address, error if not defined
		const account = this.walletClient.account;
		if (!account?.address) throw new Error("Wallet not connected");

		// compute commitment to (vaultId, tag)
		const tag = file.tag;
		const commitment = await computeTagCommitment(vaultId, tag);
		const commitmentHex = fieldToHex(commitment);
		// encrypt the actual file contents using AES-GCM locally
		// with a random ephemeral secret key
		const { encryptedData, keyMaterial } = await encryptData(file.data);
		// build ACC
		const acc = createAccBuilder()
			.requireLitAction(
				this.litActionCid,
				"go",
				[this.contentRegistry.getContractAddress(), commitmentHex],
				"true",
			)
			.build();
		// encrypt the KEY with Lit
		const keyEncryptedData = await this.litClient.encrypt({
			dataToEncrypt: keyMaterial,
			unifiedAccessControlConditions: acc,
			chain: this.chainName,
		});
		// upload ciphertext to storage (i.e. pin to IPFS)
		const upload = await this.storage.store(
			{ encryptedData, keyEncryptedData, acc },
			{ metadata: { name: tag } },
		);

		// stage the entry (not committed yet)
		this.pendingEntries.set(tag, {
			tag,
			cid: upload,
			price: file.price,
			// leaf,
			// commitment: commitmentHex,
			acc,
			extension: file.extension,
			fileType: file.fileType,
		});

		return { cid: upload };
	}

	/**
	 * Removes a file from staging (call before committing)
	 * @param tag The tag of the file
	 * @returns bool
	 */
	removeFile(tag: string): boolean {
		return this.pendingEntries.delete(tag);
	}

	/**
	 * Builds manifest from all staged files and updates the vault on-chain.
	 * Call this *after* adding all files with addFile().
	 */
	/**
	 * Builds manifest from all staged files and updates the vault on-chain.
	 * Call this *after* adding all files with addFile().
	 */
	async commitVault(vaultId: Hex): Promise<{ manifestCid: string; root: Hex }> {
		if (this.pendingEntries.size === 0) throw new Error("No files to commit");

		const entries = Array.from(this.pendingEntries.values());

		// instead of a real Merkle tree, just fake a root for now
		// this is here for future proofing... but maybe we just remove it for now?
		const rootHex = ("0x" + "0".repeat(64)) as Hex;

		// Construct manifest
		const manifest: VaultManifest = {
			version: 1,
			poseidon_root: rootHex,
			entries: entries.map((e, i) => {
				console.log("When committing the vault, we have the cid as: " + e.cid);
				return {
					tag: e.tag,
					cid: e.cid,
					price: e.price,
					index: i,
					extension: e.extension,
					fileType: e.fileType,
				};
			}),
			tree: [],
		};

		// Pin manifest
		const manifestUpload = await this.storage.store(manifest, {
			metadata: { name: `manifest-${vaultId}` },
		});

		console.log("manifest upload results in " + JSON.stringify(manifestUpload));

		// Update contract
		const hash = await this.contentRegistry.updateVault(
			vaultId,
			rootHex,
			manifestUpload,
		);
		await this.contentRegistry.waitForTransaction(hash);
		// Clear staging
		this.pendingEntries.clear();

		return { manifestCid: manifestUpload, root: rootHex };
	}

	/**
	 * Loads existing manifest
	 */
	async loadManifest(oldManifest: any) {
		// load existing entries into pending
		for (const entry of oldManifest.entries) {
			this.pendingEntries.set(entry.tag, {
				tag: entry.tag,
				cid: entry.cid,
				price: entry.price,
				// leaf: hexToField(entry.leaf),
				// commitment: entry.commitment as Hex,
				acc: null,
				extension: entry.extension,
				fileType: entry.fileType,
			});
		}
	}

	// build and sign the transferwithAuthorization call that we will pass to the facilitator
	// TODO: Move this out of here, should be in x402f lib
	public async pay(
		vaultId: Hex,
		tag: string,
		to: Address,
		auth: {
			from: Address;
			amount: bigint;
			validAfter: bigint;
			validBefore: bigint;
			nonce: Hex;
			signature: Hex;
		},
	) {
		const commitment = await computeTagCommitment(vaultId, tag);
		const commitmentHex = fieldToHex(commitment);
		const { v, r, s } = parseSignature(auth.signature);

		return await this.contentRegistry.pay({
			commitment: commitmentHex,
			from: auth.from,
			to: to,
			value: auth.amount,
			validAfter: auth.validAfter,
			validBefore: auth.validBefore,
			nonce: auth.nonce,
			v: Number(v),
			r,
			s,
		});
	}

	/**
	 * Attempt to decrypt data identified with a given tag within the given vault
	 * @param vaultId
	 * @param tag
	 * @param password
	 * @returns
	 */
	async decryptFile(
		vaultId: Hex,
		tag: string,
		authContext?: any,
	): Promise<Uint8Array<ArrayBufferLike>> {
		// load the auth context: if it's not present then assume this is running in a node env
		if (!authContext) {
			console.log("no auth context - building it now");
			const account = this.walletClient.account!;
			const authManager = createAuthManager({
				storage: storagePlugins.localStorageNode({
					appName: "fangorn",
					networkName: nagaDev.getNetworkName(),
					storagePath: "./lit-auth-storage",
				}),
			});

			const litClient = this.litClient;
			authContext = await authManager.createEoaAuthContext({
				litClient,
				config: { account: account },
				authConfig: {
					domain: this.domain,
					statement: "Please re-authenticate to enable LIT functionality. ",
					// is this the right duration for expiry?
					expiration: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(),
					// Are resources too open?
					resources: [
						["access-control-condition-decryption", "*"],
						["lit-action-execution", "*"],
					],
				},
			});
		}

		// fetch manifest
		const vault = await this.contentRegistry.getVault(vaultId);
		const manifest = await this.storage.retrieve(vault.manifestCid);

		// try to find entry
		const entry = manifest.entries.find((e) => e.tag === tag);
		if (!entry) {
			throw new Error(`Entry not found: ${tag}`);
		}
		// fetch ciphertext
		const response = await this.storage.retrieve(entry.cid);
		const { encryptedData, keyEncryptedData, acc } = response as any;

		// request decryption
		const decryptedKey = await this.litClient.decrypt({
			ciphertext: keyEncryptedData.ciphertext,
			dataToEncryptHash: keyEncryptedData.dataToEncryptHash,
			unifiedAccessControlConditions: acc,
			authContext,
			chain: this.chainName,
		});

		// recover the symmetric key
		const key = decryptedKey.decryptedData as Uint8Array<ArrayBuffer>;
		// actually decrypt the data with the recovered key
		const decryptedFile = await decryptData(encryptedData, key);

		return decryptedFile;
	}

	public async getVaultData(vaultId: Hex, tag: string) {
		// fetch manifest from pinata
		const vault = await this.getVault(vaultId);
		const manifest = await this.fetchManifest(vault.manifestCid);
		// try to find entry
		const entry = manifest.entries.find((e) => e.tag === tag);
		if (!entry) {
			throw new Error(`Entry not found: ${tag}`);
		}

		return entry;
	}

	public async getManifest(vaultId: Hex) {
		// fetch manifest from pinata
		const vault = await this.getVault(vaultId);

		if (!vault.manifestCid || vault.manifestCid == "") {
			return;
		}
		return await this.fetchManifest(vault.manifestCid);
	}

	getAddress() {
		const account = this.walletClient.account;
		if (!account?.address) throw new Error("Wallet not connected");
		return account.address;
	}

	// public async getUserVaults(): Promise<`0x${string}`[]> {
	// 	const address: Address = this.getAddress();
	// 	const vaults = await this.contentRegistry.getOwnedVaults(address);

	// 	return vaults;
	// }

	public async getVault(vaultId: Hex): Promise<Vault> {
		const vault: Vault = await this.contentRegistry.getVault(vaultId);
		return vault;
	}

	public async fetchManifest(cid: string): Promise<VaultManifest> {
		const response = await this.storage.retrieve(cid);
		console.log(
			"and the response in fangorn.ts is " + JSON.stringify(response),
		);
		return response.data as unknown as VaultManifest;
	}
}
