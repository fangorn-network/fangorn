/**
 *
 * SDK wrapper for the on-chain SettlementRegistry Stylus contract.
 *
 * Responsible for:
 *   - createResource(): owner calls once per (schemaId, tag) asset
 *   - register():       buyer pays + joins Semaphore group
 *   - settle():         buyer proves membership + fires hook (NFT/timelock)
 *   - isSettled():      access check — used to gate decryptFile()
 *   - deriveResourceId(): deterministic (owner, schemaId, tag) → bytes32
 */

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
import { TransferWithAuthParams, TransferWithAuthPayload, PrepareSettleParams, PrepareSettleResult, RegisterParams, SettleParams } from "./types";

export class SettlementRegistry {

    constructor(
        readonly contractAddress: Address,
        private readonly publicClient: PublicClient,
        private readonly walletClient: WalletClient,
    ) { }

    /**
     * Create a Semaphore group for a resource. Called by the schema owner once per (schemaId, tag) asset.
     * 
     * @param resourceId: The hex encoded resource id
     * @param price     : The USDC price for the resource
     * @returns The finalized transaction hash.
     */
    async createResource(resourceId: Hex, price: bigint): Promise<Hex> {

        const account = this.walletClient.account;
        if (!account) {
            throw new Error("The wallet client must have an account configured");
        }

        const hash = await this.walletClient.writeContract({
            address: this.contractAddress,
            abi: SETTLEMENT_REGISTRY_ABI,
            functionName: "createResource",
            args: [resourceId, price],
            chain: arbitrumSepolia,
            account,
        });

        await this.publicClient.waitForTransactionReceipt({ hash });
        return hash;
    }

    /**
     * Prepares the EIP-3009 transferWithAuthorization call and signs it w/ an EIP-712 sig
     * @param params The transferWithAuth params
     * @returns The payload containing the signed call data
     */
    async prepareTransferWithAuth(params: TransferWithAuthParams): Promise<TransferWithAuthPayload> {
        const {
            burnerPrivateKey, paymentRecipient,
            amount, usdcAddress, usdcDomainName, usdcDomainVersion,
        } = params;

        const chain = this.walletClient.chain;
        if (!chain) throw new Error("Wallet client must have a chain configured.");

        const burner = privateKeyToAccount(burnerPrivateKey);
        const burnerWallet = createWalletClient({
            account: burner, chain, transport: http(chain.rpcUrls.default.http[0]),
        });

        const validAfter = 0n;
        const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600);
        const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
        const nonce: Hex = `0x${Array.from(nonceBytes).map(b => b.toString(16).padStart(2, "0")).join("")}`;

        const sig = await burnerWallet.signTypedData({
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
                from: burner.address,
                to: paymentRecipient,
                value: amount,
                validAfter,
                validBefore,
                nonce,
            },
        });

        const { v, r, s } = parseSignature(sig);

        return {
            burnerAddress: burner.address,
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
     * Submit a payment and register with the specified semaphore group
     * @param params 
     * @returns 
     */
    async register(params: RegisterParams): Promise<Hex> {
        const { resourceId, identityCommitment, relayerPrivateKey, preparedRegister } = params;
        const {
            burnerAddress, paymentRecipient, amount,
            validAfter, validBefore, nonce, v, r, s,
        } = preparedRegister;

        const chain = this.walletClient.chain;
        if (!chain) throw new Error("Wallet client must have a chain configured.");

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
                burnerAddress,
                paymentRecipient,
                amount,
                validAfter,
                validBefore,
                nonce,
                v,
                r,
                s,
            ],
        });

        await this.publicClient.waitForTransactionReceipt({ hash });
        return hash;
    }

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

    async settle(params: SettleParams): Promise<{ hash: Hex; nullifier: bigint }> {
        const { relayerPrivateKey, preparedSettle } = params;
        const {
            resourceId, stealthAddress,
            merkleTreeDepth, merkleTreeRoot,
            nullifier, message, points,
        } = preparedSettle;

        const chain = this.walletClient.chain;
        if (!chain) throw new Error("Wallet client must have a chain configured.");

        const submitter = createWalletClient({
            account: privateKeyToAccount(relayerPrivateKey),
            chain,
            transport: http(chain.rpcUrls.default.http[0]),
        });

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
                // TODO: hooks not yet implemented
                [],
            ],
            chain: arbitrumSepolia,
            account: privateKeyToAccount(relayerPrivateKey),
        });

        const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
        console.log("settlement status " + receipt.status);

        return { hash, nullifier };
    }

    /**
     * Check if a nullifier has been settled (i.e. the user completed Phase 2).
     * Used to gate decryptFile() in the Fangorn class.
     */
    async isSettled(stealthAddress: Address, resourceId: Hex): Promise<boolean> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: SETTLEMENT_REGISTRY_ABI,
            functionName: "isSettled",
            args: [stealthAddress, resourceId],
        });
    }

    /**
     * Check if an identity commitment is registered for a resource (completed Phase 1).
     */
    async isRegistered(resourceId: Hex, identityCommitment: bigint): Promise<boolean> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: SETTLEMENT_REGISTRY_ABI,
            functionName: "isRegistered",
            args: [resourceId, identityCommitment],
        });
    }

    /**
     * Get the semaphore group id for a resource
     * @param resourceId The resource id
     * @returns The group id (if it exists), else null
     */
    async getGroupId(resourceId: Hex): Promise<bigint> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: SETTLEMENT_REGISTRY_ABI,
            functionName: "getGroupId",
            args: [resourceId],
        });
    }

    /**
     * Get the price associated with a resource
     * @param resourceId  The resource id
     * @returns The price 
     */
    async getPrice(resourceId: Hex): Promise<bigint> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: SETTLEMENT_REGISTRY_ABI,
            functionName: "getPrice",
            args: [resourceId],
        });
    }

    // utils

    /**
     * Deterministic resource_id = keccak256(ownerAddress ++ schemaName ++ tag).
     * This can be implemented in any way as long as owner/schema/tag produces a unique output
     */
    static deriveResourceId(owner: Address, schemaName: string, tag: string): Hex {
        return keccak256(
            encodePacked(
                ["address", "string", "string"],
                [owner, schemaName, tag],
            ),
        );
    }

    /**
     * Reconstruct the Semaphore group from MemberRegistered events.
     * Fetches all logs (no topic filter) and filters in JS to avoid
     * viem topic-encoding edge cases with indexed params.
     */
    private async fetchGroup(resourceId: Hex): Promise<Group> {
        const logs = await this.publicClient.getLogs({
            address: this.contractAddress,
            event: {
                name: "MemberRegistered", type: "event",
                inputs: [
                    { name: "resourceId", type: "bytes32", indexed: true },
                    { name: "groupId", type: "uint256", indexed: true },
                    { name: "identityCommitment", type: "uint256", indexed: false },
                ],
            },
            fromBlock: 0n,
        });

        const filtered = logs.filter(
            (log) => log.args.resourceId?.toLowerCase() === resourceId.toLowerCase()
        );

        const group = new Group();
        for (const log of filtered) {
            group.addMember(String(log.args.identityCommitment));
        }

        return group;
    }



    async waitForTransaction(hash: Hex) {
        const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
        return receipt;
    }
}