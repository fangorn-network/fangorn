import { createSiweMessage } from "@lit-protocol/auth-helpers";
import { LitAccessControlConditionResource, LitActionResource, LitPKPResource, } from "@lit-protocol/auth-helpers";
import { createAccBuilder } from "@lit-protocol/access-control-conditions";
import { createPublicClient, http, parseSignature, } from "viem";
import { ContentRegistry } from "./interface/contentRegistry.js";
import { computeTagCommitment } from "./crypto/proof.js";
import { fieldToHex, // could be a util func instead
 } from "./crypto/merkle.js";
import { decryptData, encryptData } from "./crypto/encryption.js";
import { createAuthManager, storagePlugins } from "@lit-protocol/auth";
export var FangornConfig;
(function (FangornConfig) {
    // A testnet config for cotnracts deployed on Base Sepolia
    FangornConfig.Testnet = {
        litActionCid: "QmP77ECWeWZPe8dsBTBG1HmpxBzkKX5D9k3v8txeEm8uFx",
        // circuitJsonCid: "QmXw1rWUC2Kw52Qi55sfW3bCR7jheCDfSUgVRwvsP8ZZPE",
        usdcContractAddress: "0x0",
        contentRegistryContractAddress: "0xc061f4e1422363a27f1b05bf65b644b29e3cec7c",
        chainName: "baseSepolia",
        rpcUrl: "https://sepolia.base.org",
    };
})(FangornConfig || (FangornConfig = {}));
// for decryption within a lit action 
// @ts-nocheck
const _litActionCode = async () => {
    try {
        // Decrypt the content using decryptAndCombine
        const decryptedContent = await Lit.Actions.decryptAndCombine({
            accessControlConditions: jsParams.accessControlConditions,
            ciphertext: jsParams.ciphertext,
            dataToEncryptHash: jsParams.dataToEncryptHash,
            authSig: jsParams.authSig,
            chain: "baseSepolia",
        });
        // Use the decrypted content for your logic
        Lit.Actions.setResponse({
            response: decryptedContent,
            success: true,
        });
    }
    catch (error) {
        Lit.Actions.setResponse({
            response: error.message,
            success: false,
        });
    }
};
const litActionCode = `(${_litActionCode.toString()})();`;
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
    storage;
    // private pinata: PinataSDK;
    // in-mem state for building manifests
    pendingEntries = new Map();
    // The domain (i.e. webserver address) that is using the Fangorn Client
    domain;
    constructor(chainName, litActionCid, 
    // circuit: CompiledCircuit,
    litClient, contentRegistry, walletClient, storage, domain) {
        this.litClient = litClient;
        this.contentRegistry = contentRegistry;
        this.walletClient = walletClient;
        this.storage = storage;
        this.litActionCid = litActionCid;
        // this.circuit = circuit;
        this.chainName = chainName;
        this.domain = domain;
    }
    static async init(walletClient, storage, litClient, domain, config) {
        const resolvedConfig = config || FangornConfig.Testnet;
        const rpcUrl = resolvedConfig.rpcUrl;
        const chainName = resolvedConfig.chainName;
        // TODO: should this be made outside of the client?
        const publicClient = createPublicClient({ transport: http(rpcUrl) });
        // interacts with the zk-gate contract
        let contentRegistryClient = new ContentRegistry(resolvedConfig.contentRegistryContractAddress, publicClient, walletClient);
        // // read the circuit from ipfs
        // // TODO: assumes the circuit exists, no error handling here
        // const circuitResponse = await pinata.gateways.public.get(
        // 	resolvedConfig.circuitJsonCid,
        // );
        // const compiledCircuit = circuitResponse.data as unknown as CompiledCircuit;
        return new Fangorn(chainName, resolvedConfig.litActionCid, 
        // compiledCircuit,
        litClient, contentRegistryClient, walletClient, storage, domain);
    }
    async registerDataSource(name) {
        // const fee = await this.contentRegistry.getVaultCreationFee();
        const { hash: createHash, vaultId } = await this.contentRegistry.registerDataSource(name);
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
                await this.storage.delete(vault.manifestCid);
            }
            catch (e) {
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
        // get the payTo address, error if not defined
        const account = this.walletClient.account;
        if (!account?.address)
            throw new Error("Wallet not connected");
        // compute commitment to (vaultId, tag)
        const tag = file.tag;
        const commitment = await computeTagCommitment(vaultId, tag);
        const commitmentHex = fieldToHex(commitment);
        // encrypt the actual file contents using AES-GCM locally
        // with a random ephemeral secret key
        const { encryptedData, keyMaterial } = await encryptData(file.data);
        const keyAsString = keyMaterial.toString();
        // build ACC
        const acc = createAccBuilder()
            .requireLitAction(this.litActionCid, "go", [this.contentRegistry.getContractAddress(), commitmentHex], "true")
            .build();
        // encrypt the KEY with Lit
        const keyEncryptedData = await this.litClient.encrypt({
            dataToEncrypt: keyAsString,
            unifiedAccessControlConditions: acc,
            chain: this.chainName,
        });
        // upload ciphertext to storage (i.e. pin to IPFS)
        const upload = await this.storage.store({ encryptedData, keyEncryptedData, acc }, { metadata: { name: tag } });
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
    removeFile(tag) {
        return this.pendingEntries.delete(tag);
    }
    /**
     * Builds manifest from all staged files and updates the vault on-chain.
     * Call this *after* adding all files with addFile().
     */
    async commitVault(vaultId) {
        if (this.pendingEntries.size === 0)
            throw new Error("No files to commit");
        const entries = Array.from(this.pendingEntries.values());
        // instead of a real Merkle tree, just fake a root for now
        // this is here for future proofing... but maybe we just remove it for now?
        const rootHex = ("0x" + "0".repeat(64));
        // Construct manifest
        const manifest = {
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
        const manifestUpload = await this.storage.store(manifest, {
            metadata: { name: `manifest-${vaultId}` },
        });
        // Update contract
        const hash = await this.contentRegistry.updateVault(vaultId, rootHex, manifestUpload);
        await this.contentRegistry.waitForTransaction(hash);
        // Clear staging
        this.pendingEntries.clear();
        return { manifestCid: manifestUpload, root: rootHex };
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
    // build and sign the transferwithAuthorization call that we will pass to the facilitator
    // TODO: Move this out of here, should be in x402f lib
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
    async decryptFile(vaultId, tag, authContext) {
        // load the auth context: if it's not present then assume this is running in a node env
        if (!authContext) {
            console.log("no auth context - building it now");
            const account = this.walletClient.account;
            const authManager = createAuthManager({
                storage: storagePlugins.localStorageNode({
                    appName: "fangorn",
                    networkName: "naga-dev",
                    storagePath: "./lit-auth-storage",
                }),
            });
            const litClient = this.litClient;
            authContext = await authManager.createEoaAuthContext({
                litClient,
                config: { account: account },
                authConfig: {
                    domain: this.domain,
                    statement: "Recover key.",
                    // is this the right duration for expiry?
                    expiration: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(),
                    // Are resources too open?
                    resources: [
                        ["access-control-condition-decryption", "*"],
                        ["lit-action-execution", "*"],
                        ["pkp-signing", "*"],
                    ],
                },
            });
        }
        const resources = [
            {
                resource: new LitAccessControlConditionResource("*"),
                ability: "access-control-condition-decryption",
            },
            {
                resource: new LitActionResource("*"),
                ability: "lit-action-execution",
            },
            {
                resource: new LitPKPResource("*"),
                ability: "pkp-signing",
            },
        ];
        const siweMessage = await createSiweMessage({
            walletAddress: this.walletClient.account.address,
            domain: "localhost",
            statement: "Decrypt data",
            uri: "https://localhost",
            version: "1",
            chainId: 1,
            expiration: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(),
            resources,
            nonce: Date.now().toString(),
        });
        // Sign it directly with your wallet
        const signature = await this.walletClient.signMessage({
            message: siweMessage,
            account: this.walletClient.account,
        });
        // Build the authSig object
        const directAuthSig = {
            sig: signature,
            derivedVia: "web3.eth.personal.sign",
            signedMessage: siweMessage,
            address: this.walletClient.account.address,
        };
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
        const { encryptedData, keyEncryptedData, acc } = response;
        console.log('got ciphertext, key ct, acc, attempting to decrypt');
        const result = await this.litClient.executeJs({
            code: litActionCode,
            authContext,
            jsParams: {
                accessControlConditions: acc,
                ciphertext: keyEncryptedData.ciphertext,
                dataToEncryptHash: keyEncryptedData.dataToEncryptHash,
                authSig: directAuthSig,
            },
        });
        console.log(result.response);
        const key = Uint8Array.from(result.response
            // 1. Strip any non-digits from the very start (BOM, [, ", etc.)
            .replace(/^[^\d]+/, "")
            .split(","), (entry) => {
            const val = parseInt(entry.trim(), 10);
            // 2. Safety check for malformed segments
            return isNaN(val) ? 0 : val;
        });
        // actually decrypt the data with the recovered key
        const decryptedFile = await decryptData(encryptedData, key);
        return decryptedFile;
    }
    /**
     * Get vault data from the contract
     * @param vaultId
     * @param tag
     * @returns
     */
    async getVaultData(vaultId, tag) {
        // fetch manifest from pinata
        const vault = await this.getVault(vaultId);
        const manifest = await this.fetchManifest(vault.manifestCid);
        // try to find entry
        const entry = manifest.entries.find((e) => e.tag === tag);
        if (!entry) {
            throw new Error(`Entry not found: ${tag}`);
        }
        //   return entry;
        return entry;
    }
    /**
     * Get the manifest from the chain
     */
    async getManifest(vaultId) {
        // fetch manifest from pinata
        const vault = await this.getVault(vaultId);
        if (!vault.manifestCid || vault.manifestCid == "") {
            return;
        }
        return await this.fetchManifest(vault.manifestCid);
    }
    /**
     * Get the contract address
     * @returns
     */
    getAddress() {
        const account = this.walletClient.account;
        if (!account?.address)
            throw new Error("Wallet not connected");
        return account.address;
    }
    // Read the data source metadata
    async getVault(vaultId) {
        const vault = await this.contentRegistry.getVault(vaultId);
        return vault;
    }
    /**
     * fetch raw manifest data from storage
     * @param cid
     * @returns
     */
    async fetchManifest(cid) {
        const response = await this.storage.retrieve(cid);
        console.log("and the response in fangorn.ts is " + JSON.stringify(response));
        return response.data;
    }
}
