import {
    createWalletClient,
    http,
    encodePacked,
    keccak256,
    parseSignature,
    type Address,
    type Hex,
    type PublicClient,
    type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Group } from "@semaphore-protocol/group";
import { generateProof, type SemaphoreProof } from "@semaphore-protocol/proof";
import { arbitrumSepolia } from "viem/chains";
import { SETTLEMENT_REGISTRY_ABI } from "./abi";
import {
    TransferWithAuthParams,
    TransferWithAuthPayload,
    PrepareSettleParams,
    PrepareSettleResult,
    RegisterParams,
    SettleParams,
} from "./types";

export class SettlementRegistry {

    constructor(
        readonly contractAddress: Address,
        private readonly publicClient: PublicClient,
        private readonly walletClient: WalletClient,
    ) { }

    private getAccount() {
        const account = this.walletClient.account;
        if (!account) throw new Error("Wallet client must have an account configured");
        return account;
    }

    private getChain() {
        const chain = this.walletClient.chain;
        if (!chain) throw new Error("Wallet client must have a chain configured");
        return chain;
    }

    // ── Admin ─────────────────────────────────────────────────────────────────

    /**
     * Authorize or revoke a DataSourceRegistry contract.
     * Only callable by the contract admin.
     */
    async setRegistry(registry: Address, authorized: boolean): Promise<Hex> {
        const account = this.getAccount();
        const hash = await this.walletClient.writeContract({
            address: this.contractAddress,
            abi: SETTLEMENT_REGISTRY_ABI,
            functionName: "setRegistry",
            args: [registry, authorized],
            chain: this.getChain(),
            account,
        });
        await this.publicClient.waitForTransactionReceipt({ hash });
        return hash;
    }

    // ── Registry-only (called via DataSourceRegistry) ─────────────────────────
    //
    // These are normally invoked by the authorized DataSourceRegistry contract,
    // not directly by the SDK. Exposed here for testing and admin tooling.

    /**
     * Create a Semaphore group for a resource.
     * In production this is called by the DataSourceRegistry, which passes
     * the publisher wallet as `owner`. Direct calls require the caller to
     * be an authorized registry.
     */
    async createResource(resourceId: Hex, price: bigint, owner: Address): Promise<Hex> {
        const account = this.getAccount();
        const hash = await this.walletClient.writeContract({
            address: this.contractAddress,
            abi: SETTLEMENT_REGISTRY_ABI,
            functionName: "createResource",
            args: [resourceId, price, owner],
            chain: this.getChain(),
            account,
        });
        await this.publicClient.waitForTransactionReceipt({ hash });
        return hash;
    }

    /**
     * Update the price for a resource.
     * In production this is called by the DataSourceRegistry.
     */
    async updatePrice(resourceId: Hex, price: bigint, owner: Address): Promise<Hex> {
        const account = this.getAccount();
        const hash = await this.walletClient.writeContract({
            address: this.contractAddress,
            abi: SETTLEMENT_REGISTRY_ABI,
            functionName: "updatePrice",
            args: [resourceId, price, owner],
            chain: this.getChain(),
            account,
        });
        await this.publicClient.waitForTransactionReceipt({ hash });
        return hash;
    }

    // ── Direct wallet calls ───────────────────────────────────────────────────

    /**
     * Register a hook contract for a resource.
     * Called directly by the publisher wallet (msg.sender must be resource owner).
     */
    async registerHook(resourceId: Hex, hook: Address): Promise<Hex> {
        const account = this.getAccount();
        const hash = await this.walletClient.writeContract({
            address: this.contractAddress,
            abi: SETTLEMENT_REGISTRY_ABI,
            functionName: "registerHook",
            args: [resourceId, hook],
            chain: this.getChain(),
            account,
        });
        await this.publicClient.waitForTransactionReceipt({ hash });
        return hash;
    }

    /**
     * Prepare the EIP-3009 transferWithAuthorization signature.
     */
    async prepareTransferWithAuth(params: TransferWithAuthParams): Promise<TransferWithAuthPayload> {
        const {
            paymentRecipient, amount, usdcAddress, usdcDomainName, usdcDomainVersion,
        } = params;

        const walletClient = params.walletClient ?? this.walletClient;
        const chain = walletClient.chain;
        if (!chain) throw new Error("Wallet client must have a chain configured.");
        const account = walletClient.account;
        if (!account) throw new Error("Wallet client must have an account configured.");

        const validAfter = 0n;
        const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600);
        const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
        const nonce: Hex = `0x${Array.from(nonceBytes).map(b => b.toString(16).padStart(2, "0")).join("")}`;

        const sig = await walletClient.signTypedData({
            account,
            domain: {
                name: usdcDomainName,
                version: usdcDomainVersion,
                chainId: chain.id,
                verifyingContract: usdcAddress,
            },
            types: {
                TransferWithAuthorization: [
                    { name: "from", type: "address" },
                    { name: "to", type: "address" },
                    { name: "value", type: "uint256" },
                    { name: "validAfter", type: "uint256" },
                    { name: "validBefore", type: "uint256" },
                    { name: "nonce", type: "bytes32" },
                ],
            },
            primaryType: "TransferWithAuthorization",
            message: {
                from: account.address,
                to: paymentRecipient,
                value: amount,
                validAfter,
                validBefore,
                nonce,
            },
        });

        const { v, r, s } = parseSignature(sig);
        return {
            sender: account.address,
            paymentRecipient,
            amount,
            validAfter,
            validBefore,
            nonce,
            v: Number(v),
            r,
            s,
        };
    }

    /**
     * Phase 1 — submit payment and join the Semaphore group.
     * Submitted via a relayer so the buyer's burner wallet is never linked
     * to their identity commitment on-chain.
     */
    async register(params: RegisterParams): Promise<Hex> {
        const { resourceId, identityCommitment, relayerPrivateKey, preparedRegister } = params;
        const {
            sender, paymentRecipient, amount,
            validAfter, validBefore, nonce, v, r, s,
        } = preparedRegister;

        const chain = this.getChain();
        const submitter = createWalletClient({
            account: privateKeyToAccount(relayerPrivateKey),
            chain,
            transport: http(chain.rpcUrls.default.http[0]),
        });

        const hash = await submitter.writeContract({
            address: this.contractAddress,
            abi: SETTLEMENT_REGISTRY_ABI,
            functionName: "register",
            args: [
                resourceId,
                identityCommitment,
                sender,
                paymentRecipient,
                amount,
                validAfter,
                validBefore,
                nonce,
                v,
                r,
                s,
            ],
            chain,
            account: privateKeyToAccount(relayerPrivateKey),
        });

        await this.publicClient.waitForTransactionReceipt({ hash });
        return hash;
    }

    /**
     * Build the Semaphore proof for Phase 2.
     */
    async prepareSettle(params: PrepareSettleParams): Promise<PrepareSettleResult> {
        const { resourceId, identity, stealthAddress } = params;

        const groupId = await this.publicClient.readContract({
            address: this.contractAddress,
            abi: SETTLEMENT_REGISTRY_ABI,
            functionName: "getGroupId",
            args: [resourceId],
        });

        if (groupId === 0n) {
            throw new Error(`No group for resource ${resourceId} — was createResource() called?`);
        }

        const group = await this.fetchGroup(resourceId);
        const proof: SemaphoreProof = await generateProof(
            identity,
            group,
            BigInt(stealthAddress),
            groupId,
        );

        return {
            resourceId,
            stealthAddress,
            merkleTreeDepth: BigInt(proof.merkleTreeDepth),
            merkleTreeRoot: BigInt(proof.merkleTreeRoot),
            nullifier: BigInt(proof.nullifier),
            message: BigInt(proof.message),
            points: proof.points.map(BigInt) as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint],
            hookData: params.hookData ?? "0x",
        };
    }

    /**
     * Phase 2 — prove group membership and claim access.
     * Submitted via a relayer for unlinkability.
     */
    async settle(params: SettleParams): Promise<{ hash: Hex; nullifier: bigint }> {
        const { relayerPrivateKey, preparedSettle } = params;
        const {
            resourceId, stealthAddress,
            merkleTreeDepth, merkleTreeRoot,
            nullifier, message, points, hookData,
        } = preparedSettle;

        const chain = this.getChain();
        const submitter = createWalletClient({
            account: privateKeyToAccount(relayerPrivateKey),
            chain,
            transport: http(chain.rpcUrls.default.http[0]),
        });

        const hookBytes = hookData && hookData !== "0x"
            ? Array.from(Buffer.from(hookData.slice(2), "hex"))
            : [];

        // TODO: proper gas estimation
        const hash = await submitter.writeContract({
            address: this.contractAddress,
            abi: SETTLEMENT_REGISTRY_ABI,
            functionName: "settle",
            gas: 8_000_000n,
            args: [
                resourceId,
                stealthAddress,
                merkleTreeDepth,
                merkleTreeRoot,
                nullifier,
                message,
                points,
                hookBytes,
            ],
            chain,
            account: privateKeyToAccount(relayerPrivateKey),
        });

        const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
        console.log("settlement status " + receipt.status);
        return { hash, nullifier };
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    async isSettled(stealthAddress: Address, resourceId: Hex): Promise<boolean> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: SETTLEMENT_REGISTRY_ABI,
            functionName: "isSettled",
            args: [stealthAddress, resourceId],
        });
    }

    async isRegistered(resourceId: Hex, identityCommitment: bigint): Promise<boolean> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: SETTLEMENT_REGISTRY_ABI,
            functionName: "isRegistered",
            args: [resourceId, identityCommitment],
        });
    }

    async getGroupId(resourceId: Hex): Promise<bigint> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: SETTLEMENT_REGISTRY_ABI,
            functionName: "getGroupId",
            args: [resourceId],
        });
    }

    async getPrice(resourceId: Hex): Promise<bigint> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: SETTLEMENT_REGISTRY_ABI,
            functionName: "getPrice",
            args: [resourceId],
        });
    }

    async getOwner(resourceId: Hex): Promise<Address> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: SETTLEMENT_REGISTRY_ABI,
            functionName: "getOwner",
            args: [resourceId],
        });
    }

    async waitForTransaction(hash: Hex) {
        return this.publicClient.waitForTransactionReceipt({ hash });
    }

    // ── Utils ─────────────────────────────────────────────────────────────────
    /**
     * Reconstruct the Semaphore group from MemberRegistered events.
     */
    private async fetchGroup(resourceId: Hex): Promise<Group> {
        const logs = await this.publicClient.getLogs({
            address: this.contractAddress,
            event: {
                name: "MemberRegistered",
                type: "event",
                inputs: [
                    { name: "resourceId", type: "bytes32", indexed: true },
                    { name: "groupId", type: "uint256", indexed: true },
                    { name: "identityCommitment", type: "uint256", indexed: false },
                ],
            },
            fromBlock: 0n,
        });

        const group = new Group();
        for (const log of logs.filter(
            l => l.args.resourceId?.toLowerCase() === resourceId.toLowerCase()
        )) {
            group.addMember(String(log.args.identityCommitment));
        }

        return group;
    }
}