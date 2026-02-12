import { Address, Hex, WalletClient } from "viem";
import { Vault } from "./interface/contentRegistry.js";
import { Filedata, VaultManifest } from "./types/index.js";
import StorageProvider from "./providers/storage/index.js";
export interface AppConfig {
    litActionCid: string;
    contentRegistryContractAddress: Hex;
    chainName: string;
    rpcUrl: string;
    usdcContractAddress: Hex;
}
export declare namespace FangornConfig {
    const Testnet: AppConfig;
}
/**
 * Fangorn class
 */
export declare class Fangorn {
    private chainName;
    private litClient;
    private litActionCid;
    private contentRegistry;
    private walletClient;
    private storage;
    private pendingEntries;
    private domain;
    constructor(chainName: string, litActionCid: string, litClient: any, contentRegistry: any, walletClient: WalletClient, storage: StorageProvider<any>, domain: string);
    static init(walletClient: WalletClient, storage: StorageProvider<any>, litClient: any, domain: string, config?: AppConfig | undefined): Promise<Fangorn>;
    registerDataSource(name: string): Promise<Hex>;
    /**
     * Upload data to an existing vault
     * @param vaultId The id of the vault being modified
     * @param filedata The file data to insert
     * @param overwrite If true, then overwrite the existing vault with new files
     * @returns The new manifest CID and Merkle root
     */
    upload(vaultId: Hex, filedata: Filedata[], overwrite?: boolean): Promise<{
        manifestCid: string;
        root: Hex;
    }>;
    /**
     * Encrypts data (with LIT) and uploads ciphertext to IPFS.
     * Does NOT update the vault!! You must call commitVault() after adding all files.
     */
    addFile(vaultId: Hex, file: Filedata): Promise<{
        cid: string;
    }>;
    /**
     * Removes a file from staging (call before committing)
     * @param tag The tag of the file
     * @returns bool
     */
    removeFile(tag: string): boolean;
    /**
     * Builds manifest from all staged files and updates the vault on-chain.
     * Call this *after* adding all files with addFile().
     */
    commitVault(vaultId: Hex): Promise<{
        manifestCid: string;
        root: Hex;
    }>;
    /**
     * Loads existing manifest
     */
    loadManifest(oldManifest: any): Promise<void>;
    pay(vaultId: Hex, tag: string, to: Address, auth: {
        from: Address;
        amount: bigint;
        validAfter: bigint;
        validBefore: bigint;
        nonce: Hex;
        signature: Hex;
    }): Promise<`0x${string}`>;
    /**
     * Attempt to decrypt data identified with a given tag within the given vault
     * @param vaultId
     * @param tag
     * @param password
     * @returns
     */
    decryptFile(vaultId: Hex, tag: string, authContext?: any): Promise<Uint8Array<ArrayBufferLike>>;
    /**
     * Get vault data from the contract
     * @param vaultId
     * @param tag
     * @returns
     */
    getVaultData(vaultId: Hex, tag: string): Promise<import("./types/index.js").VaultEntry>;
    /**
     * Get the manifest from the chain
     */
    getManifest(vaultId: Hex): Promise<VaultManifest>;
    /**
     * Get the contract address
     * @returns
     */
    getAddress(): `0x${string}`;
    getVault(vaultId: Hex): Promise<Vault>;
    /**
     * fetch raw manifest data from storage
     * @param cid
     * @returns
     */
    fetchManifest(cid: string): Promise<VaultManifest>;
}
