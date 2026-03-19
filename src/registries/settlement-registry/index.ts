/**
 * src/interface/settlement-registry/index.ts
 *
 * SDK wrapper for the on-chain SettlementRegistry Stylus contract.
 * Mirrors the pattern of DataSourceRegistry and SchemaRegistry.
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
    encodeAbiParameters,
    parseAbiParameters,
    parseSignature,
    type Address,
    type Hex,
    type PublicClient,
    type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Identity } from "@semaphore-protocol/identity";
import { Group } from "@semaphore-protocol/group";
import { generateProof, type SemaphoreProof } from "@semaphore-protocol/proof";
import { arbitrumSepolia } from "viem/chains";
import { SETTLEMENT_REGISTRY_ABI } from "./abi";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RegisterParams {
    resourceId: Hex;
    identity: Identity;
    burnerPrivateKey: Hex;           // holds USDC, signs ERC-3009 — never linked to identity
    paymentRecipient: Address;       // schema owner treasury
    amount: bigint;
    relayerPrivateKey?: Hex;           // who submits the tx (irrelevant to privacy)
    usdcAddress: Address;
    usdcDomainName: string;        // e.g. "USD Coin"
    usdcDomainVersion: string;        // e.g. "2"
}

export interface SettleParams {
    resourceId: Hex;
    identity: Identity;
    stealthAddress: Address;           // EIP-5564 stealth address — receives NFT/timelock
    hookData?: Hex;               // defaults to abi.encode(stealthAddress, "")
    callerKey: Hex;               // any wallet — proof is the auth, not msg.sender
}

export class SettlementRegistry {

    constructor(
        readonly contractAddress: Address,
        private readonly publicClient: PublicClient,
        private readonly walletClient: WalletClient,
    ) { }

    /**
     * Create a Semaphore group for a resource. Called by the schema owner
     * once per (schemaId, tag) asset — typically inside Fangorn.commit().
     */
    async createResource(resourceId: Hex, price: bigint): Promise<Hex> {
        const hash = await this.walletClient.writeContract({
            address: this.contractAddress,
            abi: SETTLEMENT_REGISTRY_ABI,
            functionName: "createResource",
            args: [resourceId, price],
            chain: arbitrumSepolia,
            account: this.walletClient.account!
        });

        // TODO: should I output the receipt? the hash isn't really needed...
        await this.publicClient.waitForTransactionReceipt({ hash });
        return hash;
        // return receipt;
    }

    /**
     * Pay via ERC-3009 and join the resource's Semaphore group.
     *
     * The burner wallet is `from` in the ERC-3009 authorization — it is never
     * linked to the identity commitment on-chain. The tx submitter (relayer or
     * burner) is also irrelevant to privacy.
     */
    async register(params: RegisterParams): Promise<Hex> {
        const {
            resourceId, identity, burnerPrivateKey, paymentRecipient,
            amount, usdcAddress, usdcDomainName, usdcDomainVersion,
        } = params;

        const chain = this.walletClient.chain!;
        const burner = privateKeyToAccount(burnerPrivateKey);
        const burnerWallet = createWalletClient({
            account: burner, chain, transport: http(chain.rpcUrls.default.http[0]),
        });

        const validAfter = 0n;
        const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600);
        const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
        const nonce = `0x${Array.from(nonceBytes).map(b => b.toString(16).padStart(2, "0")).join("")}` as Hex;

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

        // Submitter can be the relayer, burner, or anyone — doesn't affect privacy
        const submitter = params.relayerPrivateKey
            ? createWalletClient({
                account: privateKeyToAccount(params.relayerPrivateKey),
                chain,
                transport: http(chain.rpcUrls.default.http[0]),
            })
            : burnerWallet;

        const hash = await submitter.writeContract({
            address: this.contractAddress,
            abi: SETTLEMENT_REGISTRY_ABI,
            functionName: "register",
            args: [
                resourceId,
                identity.commitment,
                burner.address,
                paymentRecipient,
                amount,
                validAfter,
                validBefore,
                nonce,
                Number(v),
                r,
                s,
            ],
        });

        const _receipt = await this.publicClient.waitForTransactionReceipt({ hash });
        // TODO: receipt validations?
        return hash;
    }

    /**
     * Phase 2: Generate a ZK proof of group membership and claim access.
     * Fires the registered hook atomically (NFT mint, timelock, etc.).
     *
     * The caller can be any wallet — the Semaphore proof is the auth.
     */
    async settle(params: SettleParams): Promise<{ hash: Hex, nullifier: BigInt }> {
        const { resourceId, identity, stealthAddress, callerKey } = params;
        // const chain = this.walletClient.chain!;

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
            groupId
        );

        // TODO: hookData not yet implemented

        const hash = await this.walletClient.writeContract({
            address: this.contractAddress,
            abi: SETTLEMENT_REGISTRY_ABI,
            functionName: "settle",
            gas: 8_000_000n,
            args: [
                resourceId,
                params.stealthAddress,
                BigInt(proof.merkleTreeDepth),
                BigInt(proof.merkleTreeRoot),
                BigInt(proof.nullifier),
                BigInt(proof.message),
                proof.points.map(BigInt) as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint],
                [],
            ],
            chain: arbitrumSepolia,
            account: this.walletClient.account!
        });

        const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
        console.log('settlement status ' + receipt.status);

        return { hash, nullifier: BigInt(proof.nullifier) };
    }

    // ── Access checks ─────────────────────────────────────────────────────────

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

    async getGroupId(resourceId: Hex): Promise<bigint> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: SETTLEMENT_REGISTRY_ABI,
            functionName: "getGroupId",
            args: [resourceId],
        });
    }

    // ── Utilities ─────────────────────────────────────────────────────────────

    /**
     * Deterministic resource_id = keccak256(ownerAddress ++ schemaId ++ tag).
     * Matches the hash_concat logic in the Rust contract.
     */
    static deriveResourceId(owner: Address, schemaId: Hex, tag: string): Hex {
        return keccak256(
            encodePacked(
                ["address", "bytes32", "bytes"],
                [owner, schemaId, `0x${Buffer.from(tag).toString("hex")}`],
            ),
        );
    }

    // ── Internal ──────────────────────────────────────────────────────────────

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

        console.log(`[fetchGroup] total MemberRegistered logs: ${logs.length}`);

        const filtered = logs.filter(
            (log) => log.args.resourceId?.toLowerCase() === resourceId.toLowerCase()
        );

        console.log(`[fetchGroup] logs matching resourceId ${resourceId}: ${filtered.length}`);
        for (const log of filtered) console.log(`  commitment: ${log.args.identityCommitment}`);

        const group = new Group();
        for (const log of filtered) group.addMember(log.args.identityCommitment!.toString());

        console.log(`[fetchGroup] group size: ${group.size}`);
        return group;
    }

    async waitForTransaction(hash: Hex) {
        const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
        return receipt;
    }
}