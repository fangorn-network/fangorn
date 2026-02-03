import { createAccBuilder } from "@lit-protocol/access-control-conditions";
import { nagaDev } from "@lit-protocol/networks";
import { createPublicClient, http, parseSignature } from "viem";
import { ContentRegistry } from "./interface/contentRegistry.js";
import { computeTagCommitment } from "./crypto/proof.js";
import {
	fieldToHex, // could be a util func instead
} from "./crypto/merkle.js";
import { buildManifest } from "./types/types.js";
import { decryptData, encryptData } from "./crypto/encryption.js";
import { createAuthManager, storagePlugins } from "@lit-protocol/auth";
export var FangornConfig;
(function (FangornConfig) {
	// A testnet config for cotnracts deployed on Base Sepolia
	FangornConfig.Testnet = {
		litActionCid: "QmP77ECWeWZPe8dsBTBG1HmpxBzkKX5D9k3v8txeEm8uFx",
		// circuitJsonCid: "QmXw1rWUC2Kw52Qi55sfW3bCR7jheCDfSUgVRwvsP8ZZPE",
		usdcContractAddress: "0x0",
		contentRegistryContractAddress:
			"0xc061f4e1422363a27f1b05bf65b644b29e3cec7c",
		chainName: "baseSepolia",
		rpcUrl: "https://sepolia.base.org",
	};
})(FangornConfig || (FangornConfig = {}));
/**
 * Fangorn class
 */
export class Fangorn {
	// The name (for LIT) of the chain we are using
	chainName;
	// The LIT client for interacting with the LIT network
	litClient;
	// The CID of the lit action in storage
	litActionCid;
	// The complied noir circuit (e.g. circuit.json)
	// private circuit: CompiledCircuit;
	// The ContentRegistry Contract instance
	contentRegistry;
	// The wallet client for signing txs
	walletClient;
	// The storage layer (todo: make this into a genericc storage adapter)
	pinata;
	// in-mem state for building manifests
	pendingEntries = new Map();
	// The domain (i.e. webserver address) that is using the Fangorn Client
	domain;
	constructor(
		chainName,
		litActionCid,
		// circuit: CompiledCircuit,
		litClient,
		contentRegistry,
		walletClient,
		pinata,
		domain,
	) {
		this.litClient = litClient;
		this.contentRegistry = contentRegistry;
		this.walletClient = walletClient;
		this.pinata = pinata;
		this.litActionCid = litActionCid;
		// this.circuit = circuit;
		this.chainName = chainName;
		this.domain = domain;
	}
	static async init(walletClient, pinata, litClient, domain, config) {
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
		);
	}
	async createVault(name) {
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
	async upload(vaultId, filedata, overwrite) {
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
	async addFile(vaultId, file) {
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
	removeFile(tag) {
		return this.pendingEntries.delete(tag);
	}
	/**
	 * Builds manifest from all staged files and updates the vault on-chain.
	 * Call this *after* adding all files with addFile().
	 */
	async commitVault(vaultId) {
		if (this.pendingEntries.size === 0) throw new Error("No files to commit");
		const entries = Array.from(this.pendingEntries.values());
		// instead of a real Merkle tree, just fake a root for now
		// this is here for future proofing... but maybe we just remove it for now?
		const rootHex = "0x" + "0".repeat(64);
		const manifest = buildManifest({
			root: rootHex,
			entries: entries.map((e, i) => ({
				tag: e.tag,
				cid: e.cid,
				price: e.price,
				index: i,
				extension: e.extension,
				fileType: e.fileType,
			})),
			tree: [],
			// mock values for now....
			// these will need to be tethered to vault creation itself I think?
			// idk, maybe this should be an entirely different struct and just tore manifest cid + erc8004 separately?
			name: "Dallas Weather Terminal",
			description:
				"Real-time weather data from downtown Dallas, updated every 5 minutes",
			vaultId,
			metadata: {
				location: { lat: 32.7767, lon: -96.797 },
				tags: ["weather", "temperature", "humidity"],
			},
		});
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
	async loadManifest(oldManifest) {
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
	async pay(vaultId, tag, to, auth) {
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
		vaultId,
		tag,
		// receiptHash: Hex,
		authContext,
	) {
		// load the auth context.
		// this should be provided by the browser so
		// if it's not present then assume this is
		// running in a server env
		if (!authContext) {
			console.log("no auth context - building it now");
			const account = this.walletClient.account;
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
		const manifest = await this.fetchManifest(vault.manifestCid);
		// try to find entry
		const entry = manifest.entries.find((e) => e.tag === tag);
		if (!entry) {
			throw new Error(`Entry not found: ${tag}`);
		}
		// fetch ciphertext
		const response = await this.pinata.gateways.public.get(entry.cid);
		const { encryptedData, keyEncryptedData, acc } = response.data;
		// request decryption
		const decryptedKey = await this.litClient.decrypt({
			ciphertext: keyEncryptedData.ciphertext,
			dataToEncryptHash: keyEncryptedData.dataToEncryptHash,
			unifiedAccessControlConditions: acc,
			authContext,
			chain: this.chainName,
		});
		// recover the symmetric key
		const key = decryptedKey.decryptedData;
		// actually decrypt the data with the recovered key
		const decryptedFile = await decryptData(encryptedData, key);
		return decryptedFile;
	}
	async getVaultData(vaultId, tag) {
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
	async getManifest(vaultId) {
		// fetch manifest from pinata
		const vault = await this.getVault(vaultId);
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
	async getVault(vaultId) {
		const vault = await this.contentRegistry.getVault(vaultId);
		return vault;
	}
	async fetchManifest(cid) {
		console.log("getting cid " + cid);
		const response = await this.pinata.gateways.public.get(cid);
		return response.data;
	}
}
