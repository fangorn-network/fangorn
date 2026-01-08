import { createLitClient } from "@lit-protocol/lit-client";
import { createAccBuilder } from "@lit-protocol/access-control-conditions";
import { nagaDev } from "@lit-protocol/networks";
import {
	Account,
	Address,
	createPublicClient,
	createWalletClient,
	custom,
	Hex,
	http,
	toHex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { Vault, ZKGate } from "./interface/zkGate.js";
import { hashPassword } from "./utils/index.js";
import { buildCircuitInputs, computeTagCommitment } from "./crypto/proof.js";
import {
	buildTreeFromLeaves,
	fieldToHex,
	hexToField,
} from "./crypto/merkle.js";
import { VaultEntry, VaultManifest } from "./types/types.js";
import { PinataSDK } from "pinata";
import { Barretenberg, UltraHonkBackend } from "@aztec/bb.js";
import { CompiledCircuit, Noir } from "@noir-lang/noir_js";
import { createAuthManager, storagePlugins } from "@lit-protocol/auth";

// intermediate entry struct
interface PendingEntry {
	tag: string;
	cid: string;
	leaf: bigint;
	commitment: Hex;
	acc: any;
}

// TODO add to types.ts
export interface Filedata {
	tag: string;
	data: string;
}

/**
 *
 */
export class Fangorn {
	private litClient: any;
	private zkGate: any;

	private walletClient: any;

	private pinata: PinataSDK;

	// in-mem state for building manifests
	private pendingEntries: Map<string, PendingEntry> = new Map();

	constructor(
		litClient: any,
		zkGate: any,
		walletClient: any,
		pinata: PinataSDK,
	) {
		this.litClient = litClient;
		this.zkGate = zkGate;

		this.walletClient = walletClient;

		this.pinata = pinata;
	}

	public static async init(
		account: Account,
		rpcUrl: string,
		zkGateContractAddress: Address,
		jwt: string,
		gateway: string,
	) {
		// client to interact with LIT proto
		const litClient = await createLitClient({
			// @ts-expect-error - TODO: fix this
			network: nagaDev,
		});

		const publicClient = createPublicClient({ transport: http(rpcUrl) });
		let walletClient;

		if (!window.ethereum) {
			walletClient = createWalletClient({
				account,
				transport: http(rpcUrl),
				chain: baseSepolia,
			});
		} else {
			walletClient = createWalletClient({
				account,
				transport: custom(window.ethereum),
				chain: baseSepolia,
			});
		}

		// interacts with the zk-gate contract
		let zkGateClient = new ZKGate(
			zkGateContractAddress,
			publicClient,
			walletClient,
		);

		// storage via Pinata
		const pinata = new PinataSDK({
			pinataJwt: jwt,
			pinataGateway: gateway,
		});

		return new Fangorn(litClient, zkGateClient, walletClient, pinata);
	}

	// TODO: how to ensure password is zeroized?
	async createVault(password: string): Promise<Hex> {
		let passwordHash = hashPassword(password);
		const fee = await this.zkGate.getVaultCreationFee();
		const { hash: createHash, vaultId } = await this.zkGate.createVault(
			passwordHash,
			fee,
		);
		await this.zkGate.waitForTransaction(createHash);
		return vaultId;
	}

	async upload(
		vaultId: Hex,
		filedata: Filedata[],
		litActionCid: string,
		overwrite?: boolean,
	) {
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
			await this.addFile(vaultId, file.tag, file.data, litActionCid);
		}
		return await this.commitVault(vaultId);
	}

	/**
	 * Encrypts data (with LIT) and uploads ciphertext to IPFS.
	 * Does NOT update the vault!! You must call commitVault() after adding all files.
	 */
	async addFile(
		vaultId: Hex,
		tag: string,
		plaintext: string,
		litActionCid: string,
	): Promise<{ cid: string; commitment: Hex }> {
		// compute commitment to (vaultId, tag)
		const leaf = await computeTagCommitment(vaultId, tag);
		const commitmentHex = fieldToHex(leaf);

		// build ACC
		const acc = createAccBuilder()
			.requireLitAction(
				litActionCid,
				"go",
				[this.zkGate.getContractAddress(), vaultId, commitmentHex],
				"true",
			)
			.build();

		// encrypt
		const encryptedData = await this.litClient.encrypt({
			dataToEncrypt: plaintext,
			unifiedAccessControlConditions: acc,
			chain: "baseSepolia", // TODO: this should probably be dynamic
		});

		// upload ciphertext (pin)
		const upload = await this.pinata.upload.public.json(
			{ encryptedData, acc },
			{ metadata: { name: tag } },
		);

		// stage the entry (not committed yet)
		this.pendingEntries.set(tag, {
			tag,
			cid: upload.cid,
			leaf,
			commitment: commitmentHex,
			acc,
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
			});
		}
	}

	async decryptFile(
		vaultId: Hex,
		tag: string,
		password: string,
		circuit: any,
	): Promise<string> {
		// load the auth context
		const authManager = createAuthManager({
			storage: storagePlugins.localStorageNode({
				appName: "fangorn",
				networkName: nagaDev.getNetworkName(),
				storagePath: "./lit-auth-storage",
			}),
		});

		const litClient = this.litClient;
		const authContext = await authManager.createEoaAuthContext({
			litClient,
			config: {
				account: this.walletClient.account,
			},
			authConfig: {
				domain: "localhost", // TODO: do we need to update this?
				statement: "Decrypt test data", // Do we need this?
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
			await this.proveAccess(vaultId, password, entry, manifest, circuit);
		}

		// fetch ciphertext
		const response = await this.pinata.gateways.public.get(entry.cid);
		const { encryptedData, acc } = response.data as any;

		// request decryption
		const decrypted = await this.litClient.decrypt({
			ciphertext: encryptedData.ciphertext,
			dataToEncryptHash: encryptedData.dataToEncryptHash,
			unifiedAccessControlConditions: acc,
			authContext,
			chain: "baseSepolia",
		});

		return new TextDecoder().decode(decrypted.decryptedData);
	}

	// proof gen
	private async proveAccess(
		vaultId: Hex,
		password: string,
		entry: VaultEntry,
		manifest: VaultManifest,
		circuit: CompiledCircuit,
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
		const backend = new UltraHonkBackend(circuit.bytecode, api);
		const noir = new Noir(circuit);
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
