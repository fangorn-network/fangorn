import { createLitClient, LitClient } from "@lit-protocol/lit-client";
import { createAccBuilder } from "@lit-protocol/access-control-conditions";
import { nagaDev } from "@lit-protocol/networks";
import {
	Address,
	Chain,
	createPublicClient,
	Hex,
	hexToBytes,
	http,
	keccak256,
	parseEventLogs,
	parseSignature,
	parseUnits,
	toHex,
	WalletClient,
} from "viem";
import {
	Vault,
	ContentRegistry,
	CONTENTREGISTRY_ABI,
} from "./interface/contentRegistry.js";
// import { hashPassword } from "./utils/index.js";
import { computeTagCommitment } from "./crypto/proof.js";
import {
	buildTreeFromLeaves,
	fieldToHex,
	hexToField,
} from "./crypto/merkle.js";
import {
	Filedata,
	PendingEntry,
	VaultEntry,
	VaultManifest,
} from "./types/types.js";
import { PinataSDK } from "pinata";
import { Barretenberg, UltraHonkBackend } from "@aztec/bb.js";
import { CompiledCircuit, Noir } from "@noir-lang/noir_js";
import { decryptData, encryptData } from "./crypto/encryption.js";
import { createAuthManager, storagePlugins } from "@lit-protocol/auth";
import { getTransactionCount } from "viem/actions";
import { deriveVaultId } from "./utils/index.js";

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
		litActionCid: "QmcDkeo7YnJbuyYnXfxcnB65UCkjFhLDG5qa3hknMmrDmQ",
		// circuitJsonCid: "QmXw1rWUC2Kw52Qi55sfW3bCR7jheCDfSUgVRwvsP8ZZPE",
		usdcContractAddress: "0x0",
		contentRegistryContractAddress:
			"0x062da4924251c7ed392afc01f57d7ea2c255dc81",
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
	private pinata: PinataSDK;
	// in-mem state for building manifests
	private pendingEntries: Map<string, PendingEntry> = new Map();
	// The domain (i.e. webserver address) that is using the Fangorn Client
	private domain: string;

	private usdcContractAddress: Address;

	constructor(
		chainName: string,
		litActionCid: string,
		// circuit: CompiledCircuit,
		litClient: any,
		contentRegistry: any,
		walletClient: WalletClient,
		pinata: PinataSDK,
		domain: string,
		usdcContractAddress: Hex,
	) {
		this.litClient = litClient;
		this.contentRegistry = contentRegistry;
		this.walletClient = walletClient;
		this.pinata = pinata;
		this.litActionCid = litActionCid;
		// this.circuit = circuit;
		this.chainName = chainName;
		this.domain = domain;
		this.usdcContractAddress = usdcContractAddress;
	}

	public static async init(
		jwt: string,
		gateway: string,
		walletClient: WalletClient,
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
			publicClient,
			walletClient,
		);

		// storage via Pinata
		const pinata = new PinataSDK({
			pinataJwt: jwt,
			pinataGateway: gateway,
		});

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
			pinata,
			domain,
			resolvedConfig.usdcContractAddress,
		);
	}

	async createVault(name: string): Promise<Hex> {
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
				await this.pinata.files.public.delete([vault.manifestCid]);
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
		// compute commitment to (vaultId, tag)
		const tag = file.tag;
		const commitment = await computeTagCommitment(vaultId, tag);
		const commitmentHex = fieldToHex(commitment);

		// encrypt the actual file contents using AES-GCM locally
		// with a random ephemeral secret key
		const { encryptedData, keyMaterial } = await encryptData(file.data);

		// get the payTo address, error if not defined
		const account = this.walletClient.account;
		if (!account?.address) throw new Error("Wallet not connected");
		const payTo = account.address;

		// build ACC
		const acc = createAccBuilder()
			.requireLitAction(
				this.litActionCid,
				"go",
				[this.contentRegistry.getContractAddress(), commitmentHex],
				"true",
			)
			.build();

		// encrypt the KEY with LIT protocol
		const keyEncryptedData = await this.litClient.encrypt({
			dataToEncrypt: keyMaterial,
			unifiedAccessControlConditions: acc,
			chain: this.chainName,
		});

		// upload ciphertext (pin)
		const upload = await this.pinata.upload.public.json(
			{ encryptedData, keyEncryptedData, acc },
			{ metadata: { name: tag } },
		);

		// stage the entry (not committed yet)
		this.pendingEntries.set(tag, {
			tag,
			cid: upload.cid,
			price: file.price,
			// leaf,
			// commitment: commitmentHex,
			acc,
			extension: file.extension,
			fileType: file.fileType,
		});

		return { cid: upload.cid };
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
			entries: entries.map((e, i) => ({
				tag: e.tag,
				cid: e.cid,
				price: e.price,
				index: i,
				extension: e.extension,
				fileType: e.fileType,
			})),
			tree: [],
		};

		// Pin manifest
		const manifestUpload = await this.pinata.upload.public.json(manifest, {
			metadata: { name: `manifest-${vaultId}` },
		});

		// Update contract
		const hash = await this.contentRegistry.updateVault(
			vaultId,
			rootHex,
			manifestUpload.cid,
		);
		await this.contentRegistry.waitForTransaction(hash);

		// Clear staging
		this.pendingEntries.clear();

		return { manifestCid: manifestUpload.cid, root: rootHex };
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

	// build and sign the transferwithauthorization call that we will pass to the facilitator
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

	generateRandomHex(size: number) {
		return [...Array(size)]
			.map(() => Math.floor(Math.random() * 16).toString(16))
			.join("") as Hex;
	}

	// async pay(
	// 	vaultId: Hex,
	// 	tag: string,
	// 	amount: string,
	// 	to: Address,
	// ) {
	// 	// compute the commitment
	// 	const commitment = await computeTagCommitment(vaultId, tag);
	// 	const commitmentHex = fieldToHex(commitment);

	// 	const value = parseUnits(amount, 6);
	// 	// Update contract
	// 	const hash = await this.contentRegistry.pay(
	// 		value,
	// 		commitmentHex,
	// 		to,
	// 	);
	// 	await this.contentRegistry.waitForTransaction(hash);
	// }

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
		// receiptHash: Hex,
		authContext?: any,
	): Promise<Uint8Array<ArrayBufferLike>> {
		// load the auth context.
		// this should be provided by the browser so
		// if it's not present then assume this is
		// running in a server env
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

		// fetch manifest from pinata
		const vault = await this.contentRegistry.getVault(vaultId);

		console.log("got the vault manifest cid " + vault.manifestCid);

		const manifest = await this.fetchManifest(vault.manifestCid);

		console.log(
			"found the manifest w/ " + manifest.entries.length + " entries",
		);

		// try to find entry
		const entry = manifest.entries.find((e) => e.tag === tag);
		if (!entry) {
			throw new Error(`Entry not found: ${tag}`);
		}

		console.log("found entry with cid " + entry.cid);

		// fetch ciphertext
		const response = await this.pinata.gateways.public.get(entry.cid);
		const { encryptedData, keyEncryptedData, acc } = response.data as any;

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
		const response = await this.pinata.gateways.public.get(cid);
		return response.data as unknown as VaultManifest;
	}
}
