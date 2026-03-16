/**
 * src/testing/testbed.ts
 *
 * Updated TestBed: replaces SettlementTracker with SettlementRegistry.
 * Adds register() + settle() to the buyer flow and threads Identity through
 * the decrypt path.
 */

import {
    Address,
    Chain,
    Hex,
    WalletClient,
    parseSignature as viemParseSignature,
} from "viem";
import { Identity } from "@semaphore-protocol/identity";
import { Fangorn } from "../fangorn.js";
import { Filedata } from "../types/index.js";
import { PinataStorage } from "../providers/storage/pinata/index.js";
import { AppConfig } from "../config.js";
import { arbitrumSepolia, baseSepolia } from "viem/chains";
import { LitEncryptionService } from "../modules/encryption/lit.js";
import { SettlementRegistry } from "../interface/settlement-registry/index.js";
import { emptyWallet } from "./test-gadget.js";
import { EvmChain } from "@lit-protocol/access-control-conditions";

export class TestBed {
    private delegatorFangorn: Fangorn;
    private delegateeFangorn: Fangorn;
    private delegatorAddress: Address;
    private storage: PinataStorage;
    private usdcContractAddress: Address;
    private usdcDomainName: string;
    private config: AppConfig;
    private litChain: EvmChain;

    constructor(
        delegatorAddress: Address,
        delegatorFangorn: Fangorn,
        delegateeFangorn: Fangorn,
        storage: PinataStorage,
        config: AppConfig,
        litChain: EvmChain,
        usdcContractAddress: Address,
        usdcDomainName: string,
    ) {
        this.delegatorAddress = delegatorAddress;
        this.delegatorFangorn = delegatorFangorn;
        this.delegateeFangorn = delegateeFangorn;
        this.config = config;
        this.litChain = litChain;
        this.storage = storage;
        this.usdcContractAddress = usdcContractAddress;
        this.usdcDomainName = usdcDomainName;
    }

    public static async init(
        delegatorWalletClient: WalletClient,
        delegateeWalletClient: WalletClient,
        jwt: string,
        gateway: string,
        dataSourceRegistryContractAddress: Hex,
        schemaRegistryContractAddress: Hex,
        settlementRegistryContractAddress: Hex,
        usdcContractAddress: Hex,
        usdcDomainName: string,
        rpcUrl: string,
        chain: string,
        litChain: EvmChain,
        caip2: number,
    ) {
        let chainImpl: Chain = arbitrumSepolia;
        if (chain === "baseSepolia") chainImpl = baseSepolia;

        const config: AppConfig = {
            dataSourceRegistryContractAddress,
            schemaRegistryContractAddress,
            settlementRegistryContractAddress,
            chainName: chain,
            chain: chainImpl,
            rpcUrl,
            caip2,
        };

        const delegatorEncryption = await LitEncryptionService.init(chain);
        const delegateeEncryption = await LitEncryptionService.init(chain);
        const delegatorStorage    = new PinataStorage(jwt, gateway);
        const delegateeStorage    = new PinataStorage(jwt, gateway);

        const delegatorFangorn = Fangorn.init(delegatorWalletClient, delegatorStorage, delegatorEncryption, "localhost", config);
        const delegateeFangorn = Fangorn.init(delegateeWalletClient, delegateeStorage, delegateeEncryption, "localhost", config);

        if (!delegatorWalletClient.account) throw new Error("Delegator account not found");

        return new TestBed(
            delegatorWalletClient.account.address,
            delegatorFangorn,
            delegateeFangorn,
            delegatorStorage,
            config,
            litChain,
            usdcContractAddress,
            usdcDomainName,
        );
    }

    // ── Schema ────────────────────────────────────────────────────────────────

    async registerSchema(name: string, specCid: string, agentId: string): Promise<Hex> {
        const { schemaId } = await this.delegatorFangorn
            .getSchemaRegistry()
            .registerSchema(name, specCid, agentId);
        return schemaId;
    }

    // ── Upload ────────────────────────────────────────────────────────────────

    async fileUploadEmptyWallet(filedata: Filedata[], schemaId: Hex): Promise<string> {
        return this.delegatorFangorn.upload(
            filedata,
            () => emptyWallet(this.litChain),
            schemaId,
        );
    }

    // ── Settlement: register (Phase 1) ────────────────────────────────────────

    /**
     * Buyer pays via ERC-3009 and joins the resource's Semaphore group.
     * `burnerPrivateKey` holds USDC and signs the authorization — it is never
     * linked to `identity` on-chain.
     *
     * Awaits tx confirmation before returning so the caller can immediately
     * proceed to settle().
     */
    async register(
        owner: Address,
        schemaId: Hex,
        tag: string,
        identity: Identity,
        burnerPrivateKey: Hex,
        amount: bigint,
    ): Promise<Hex> {
        const publicClient = this.delegateeFangorn
            .getDatasourceRegistry()
            // borrow the public client already wired up inside the SDK
            // @ts-ignore — accessing internal for test convenience
            ["publicClient"] as any;

        const txHash = await this.delegateeFangorn.register(owner, schemaId, tag, {
            identity,
            burnerPrivateKey,
            paymentRecipient: owner,              // USDC goes to the schema owner
            amount,
            usdcAddress:       this.usdcContractAddress,
            usdcDomainName:    this.usdcDomainName,
            usdcDomainVersion: "2",
        });

        // Wait for confirmation so settle() can reconstruct the group
        const walletChain = this.delegateeFangorn.getWalletClient().chain!;
        const { createPublicClient, http } = await import("viem");
        const pc = createPublicClient({ chain: walletChain, transport: http(this.config.rpcUrl) });
        await pc.waitForTransactionReceipt({ hash: txHash });

        return txHash;
    }

    // ── Settlement: settle (Phase 2) ──────────────────────────────────────────

    /**
     * Buyer generates a ZK proof of group membership and fires the hook.
     * `callerKey` can be any funded wallet — the proof is the auth.
     * `stealthAddress` receives the soulbound NFT (or timelock entry).
     */
    async settle(
        owner: Address,
        schemaId: Hex,
        tag: string,
        identity: Identity,
        stealthAddress: Address,
        callerKey: Hex,
    ): Promise<Hex> {
        return this.delegateeFangorn.settle(owner, schemaId, tag, {
            identity,
            stealthAddress,
            callerKey,
        });
    }

    // ── Read / decrypt ────────────────────────────────────────────────────────

    /**
     * Decrypt as the delegatee (buyer). Requires a settled identity by default.
     * Pass `requireSettlement: false` to skip the gate (owner, dev usage).
     */
    async tryDecrypt(
        owner: Address,
        schemaId: Hex,
        tag: string,
        identity?: Identity,
        requireSettlement = true,
    ): Promise<Uint8Array> {
        return this.delegateeFangorn.decryptFile(owner, schemaId, tag, {
            identity,
            requireSettlement,
        });
    }

    async tryDecryptDelegator(owner: Address, schemaId: Hex, tag: string): Promise<Uint8Array> {
        // Owner always bypasses settlement check
        return this.delegatorFangorn.decryptFile(owner, schemaId, tag, {
            requireSettlement: false,
        });
    }

    async checkManifestExists(who: Address, schemaId: Hex): Promise<boolean> {
        const manifest = await this.delegatorFangorn.getManifest(who, schemaId);
        return manifest !== undefined;
    }

    async checkEntryExists(who: Address, schemaId: Hex, tag: string): Promise<boolean> {
        try {
            await this.delegatorFangorn.getEntry(who, schemaId, tag);
            return true;
        } catch {
            return false;
        }
    }

    // ── Accessors ─────────────────────────────────────────────────────────────

    getDelegatorAddress(): Address { return this.delegatorAddress; }
    getDelegatorFangorn(): Fangorn { return this.delegatorFangorn; }
    getDelegateeFangorn(): Fangorn { return this.delegateeFangorn; }
    getSettlementRegistry(): SettlementRegistry {
        return this.delegatorFangorn.getSettlementRegistry();
    }
}