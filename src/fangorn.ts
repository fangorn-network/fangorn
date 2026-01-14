import { createLitClient } from "@lit-protocol/lit-client";
import { createAccBuilder } from "@lit-protocol/access-control-conditions";
import { nagaDev } from "@lit-protocol/networks";
import {
	Account,
	Address,
	Chain,
	createPublicClient,
	createWalletClient,
	custom,
	getAddress,
	Hex,
	http,
	toHex,
} from "viem";
import { baseSepolia, filecoin } from "viem/chains";
import { Vault, ZKGate } from "./interface/zkGate.js";
import { hashPassword } from "./utils/index.js";
import { buildCircuitInputs, computeTagCommitment } from "./crypto/proof.js";
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
import {
	createAuthManager,
	storagePlugins,
	WalletClientAuthenticator,
} from "@lit-protocol/auth";
import { WalletClientAuthenticateOverrides } from "@lit-protocol/auth/src/lib/authenticators/WalletClientAuthenticator.js";

export interface AppConfig {
	// The CID pointing to the expected LIT action
	litActionCid: string;
	// The CID pointing to the compiled circuit json
	circuitJsonCid: string;
	// The deployed zkGate contract address
	zkGateContractAddress: Hex;
	//  The chain we are deploying to
	chain: Chain;
	// The name of the chain for LIT action execution (does not always match what is defined by viem)
	chainName: string;
	// The public rpc address of the chain we are connecting to
	rpcUrl: string;
}

export namespace FangornConfig {
	// A testnet config for cotnracts deployed on Base Sepolia
	export const Testnet: AppConfig = {
		litActionCid: "QmcDkeo7YnJbuyYnXfxcnB65UCkjFhLDG5qa3hknMmrDmQ",
		circuitJsonCid: "QmXw1rWUC2Kw52Qi55sfW3bCR7jheCDfSUgVRwvsP8ZZPE",
		zkGateContractAddress: "0x062da4924251c7ed392afc01f57d7ea2c255dc81",
		chain: baseSepolia,
		chainName: "baseSepolia",
		rpcUrl: "https://sepolia.base.org",
	};
}

const DOMAIN = "https://vault-demo.fangorn.network";

/**
 * Fangorn class
 */
export class Fangorn {
	// The name (for LIT) of the chain we are using
	private chainName: string;
	// The LIT client for interacting with the LIT network
	private litClient: any;
	// The CID of the lit action in storage
	private litActionCid: string;
	// The complied noir circuit (e.g. circuit.json)
	private circuit: CompiledCircuit;
	// The ZKGate Contract instance
	private zkGate: any;
	// The wallet client for signing txs
	private walletClient: any;
	// The storage layer (todo: make this into a genericc storage adapter)
	private pinata: PinataSDK;
	// in-mem state for building manifests
	private pendingEntries: Map<string, PendingEntry> = new Map();

	constructor(
		chainName: string,
		litActionCid: string,
		circuit: CompiledCircuit,
		litClient: any,
		zkGate: any,
		walletClient: any,
		pinata: PinataSDK,
		config: AppConfig,
	) {
		this.litClient = litClient;
		this.zkGate = zkGate;
		this.walletClient = walletClient;
		this.pinata = pinata;
		this.litActionCid = litActionCid;
		this.circuit = circuit;
		this.chainName = chainName;
	}

	public static async init(
		account: Account | Address,
		jwt: string,
		gateway: string,
		config?: AppConfig | undefined,
	) {
		const resolvedConfig = config || FangornConfig.Testnet;
		const rpcUrl = resolvedConfig.rpcUrl;
		const chain = resolvedConfig.chain;
		const chainName = resolvedConfig.chainName;

		const publicClient = createPublicClient({ transport: http(rpcUrl) });
		let walletClient;

		if (typeof window === "undefined") {
			walletClient = createWalletClient({
				account,
				transport: http(rpcUrl),
				chain: chain,
			});
		} else {
			walletClient = createWalletClient({
				account: getAddress(account as Address),
				transport: custom(window.ethereum),
				chain: chain,
			});
		}

		const siweMessageOverrides: WalletClientAuthenticateOverrides = {
			domain: DOMAIN,
			statement: "This is the statement",
		};
		const messageToSign = "Please sign in to enable LIT functionality.";

		await WalletClientAuthenticator.authenticate(
			walletClient,
			messageToSign,
			siweMessageOverrides,
		);
		// client to interact with LIT proto
		const litClient = await createLitClient({
			// @ts-expect-error - TODO: fix this
			network: nagaDev,
		});

		// interacts with the zk-gate contract
		let zkGateClient = new ZKGate(
			resolvedConfig.zkGateContractAddress,
			publicClient,
			walletClient,
		);

		// storage via Pinata
		const pinata = new PinataSDK({
			pinataJwt: jwt,
			pinataGateway: gateway,
		});

		// read the circuit from ipfs
		// TODO: assumes the circuit exists, no error handling here
		const circuitResponse = await pinata.gateways.public.get(
			resolvedConfig.circuitJsonCid,
		);
		const compiledCircuit = circuitResponse.data as unknown as CompiledCircuit;

		return new Fangorn(
			chainName,
			resolvedConfig.litActionCid,
			compiledCircuit,
			litClient,
			zkGateClient,
			walletClient,
			pinata,
			resolvedConfig,
		);
	}

	// TODO: how to ensure password is zeroized?
	async createVault(name: string, password: string): Promise<Hex> {
		let passwordHash = hashPassword(password);
		const fee = await this.zkGate.getVaultCreationFee();
		const { hash: createHash, vaultId } = await this.zkGate.createVault(
			name,
			passwordHash,
			fee,
		);
		await this.zkGate.waitForTransaction(createHash);
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
		const vault = await this.zkGate.getVault(vaultId);
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
	async addFile(
		vaultId: Hex,
		file: Filedata,
	): Promise<{ cid: string; commitment: Hex }> {
		// compute commitment to (vaultId, tag)
		const tag = file.tag;
		const leaf = await computeTagCommitment(vaultId, tag);
		const commitmentHex = fieldToHex(leaf);

		// encrypt the actual file contents using AES-GCM locally
		const { encryptedData, keyMaterial } = await encryptData(file.data);

		// build ACC
		const acc = createAccBuilder()
			.requireLitAction(
				this.litActionCid,
				"go",
				[this.zkGate.getContractAddress(), vaultId, commitmentHex],
				"true",
			)
			.build();

		// encrypt THE KEY with LIT protocol
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
			leaf,
			commitment: commitmentHex,
			acc,
			extension: file.extension,
			fileType: file.fileType,
		});

		return { cid: upload.cid, commitment: commitmentHex };
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
		if (this.pendingEntries.size === 0) {
			throw new Error("No files to commit");
		}

		// build Merkle tree
		const entries = Array.from(this.pendingEntries.values());
		const leaves = entries.map((e) => e.leaf);
		const { root, layers } = await buildTreeFromLeaves(leaves);
		const rootHex = fieldToHex(root);

		// construct new manifest
		const manifest: VaultManifest = {
			version: 1,
			poseidon_root: rootHex,
			entries: entries.map((e, i) => ({
				tag: e.tag,
				cid: e.cid,
				index: i,
				leaf: fieldToHex(e.leaf),
				commitment: e.commitment,
				extension: e.extension,
				fileType: e.fileType,
			})),
			tree: layers.map((layer) => layer.map(fieldToHex)),
		};

		// pin the manifest
		const manifestUpload = await this.pinata.upload.public.json(manifest, {
			metadata: { name: `manifest-${vaultId}` },
		});

		// update contract
		const hash = await this.zkGate.updateVault(
			vaultId,
			rootHex,
			manifestUpload.cid,
		);
		await this.zkGate.waitForTransaction(hash);

		// clear pending entries
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
				leaf: hexToField(entry.leaf),
				commitment: entry.commitment as Hex,
				acc: null,
				extension: entry.extension,
				fileType: entry.fileType,
			});
		}
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
		password: string,
	): Promise<Uint8Array<ArrayBufferLike>> {
		const isWindowUndefined = typeof window === "undefined";
		const account = isWindowUndefined
			? this.walletClient.account
			: this.walletClient;
		// load the auth context
		const authManager = isWindowUndefined
			? // node.js support
				createAuthManager({
					storage: storagePlugins.localStorageNode({
						appName: "fangorn",
						networkName: nagaDev.getNetworkName(),
						storagePath: "./lit-auth-storage",
					}),
				})
			: // browser support
				createAuthManager({
					storage: storagePlugins.localStorage({
						appName: "fangorn",
						networkName: nagaDev.getNetworkName(),
					}),
				});

		const litClient = this.litClient;
		const authContext = await authManager.createEoaAuthContext({
			litClient,
			config: { account: account },
			authConfig: {
				domain: DOMAIN,
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

		// fetch manifest from pinata
		const vault = await this.zkGate.getVault(vaultId);
		const manifest = await this.fetchManifest(vault.manifestCid);

		// try to find entry
		const entry = manifest.entries.find((e) => e.tag === tag);
		if (!entry) {
			throw new Error(`Entry not found: ${tag}`);
		}

		// check if already have access (do not need to reverify)
		const userAddress = this.walletClient.account.address;
		const hasAccess = await this.zkGate.checkCIDAccess(
			vaultId,
			entry.commitment as Hex,
			userAddress,
		);

		// we don't need to request access if we already have it
		if (!hasAccess) {
			await this.proveAccess(vaultId, password, entry, manifest);
		}

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
		const key = decryptedKey.decryptedData;
		// actually decrypt the data with the recovered key
		const decryptedFile = await decryptData(encryptedData, key);

		return decryptedFile;
	}

	// proof gen
	private async proveAccess(
		vaultId: Hex,
		password: string,
		entry: VaultEntry,
		manifest: VaultManifest,
	): Promise<void> {
		const userAddress = this.walletClient.account.address;

		// build circuit inputs
		const { inputs, nullifier, cidCommitment } = await buildCircuitInputs(
			password,
			entry,
			userAddress,
			vaultId,
			manifest,
		);

		const api = await Barretenberg.new({ threads: 1 });
		const backend = new UltraHonkBackend(this.circuit.bytecode, api);
		const noir = new Noir(this.circuit);
		const { witness } = await noir.execute(inputs);
		const proofResult = await backend.generateProof(witness, {
			verifierTarget: "evm",
		});

		const proofHex: Hex = toHex(proofResult.proof);
		// submit onchain
		const hash = await this.zkGate.submitProof(
			vaultId,
			cidCommitment,
			nullifier,
			proofHex,
		);
		await this.zkGate.waitForTransaction(hash);
	}

	public async getUserVaults(): Promise<string[]> {
		const address: Address = this.walletClient.account.address;
		const vaults = await this.zkGate.getOwnedVaults(address);

		return vaults;
	}

	public async getVault(vaultId: Hex): Promise<Vault> {
		const vault: Vault = await this.zkGate.getVault(vaultId);
		return vault;
	}

	public async fetchManifest(cid: string): Promise<VaultManifest> {
		const response = await this.pinata.gateways.public.get(cid);
		return response.data as unknown as VaultManifest;
	}
}
