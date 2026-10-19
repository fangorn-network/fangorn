import {
    ContractFunctionArgs,
    ContractFunctionName,
    ContractFunctionReturnType,
    erc20Abi,
    hexToBigInt,
    type Abi,
    type Address,
    type Hash,
    type Hex,
    type PublicClient,
    type WalletClient,
} from "viem";

import { APP_REGISTRY_ABI } from "./abi.js";
import { prepareWrite, requireWallet, sendWrite, type PreparedTx } from "../write.js";
import { getLogsInWindows } from "../logs.js";
import { PublisherStatus } from "../types.js";

export type { PreparedTx } from "../write.js";

type ViewName = ContractFunctionName<typeof APP_REGISTRY_ABI, "view" | "pure">;
type WriteName = ContractFunctionName<typeof APP_REGISTRY_ABI, "payable" | "nonpayable">;

/**
 * The information required of a publisher in order to join an app
 */
export interface AppJoinInfo {
    /** The app's terms hash (zero means no terms); e.g. an IPFS cid  */
    termsHash: Hex;
    /** A uri pointing to the terms: e.g. an IPFS gateway+CID */
    termsUri: string;
    /** What joining costs, in USDC base units (6 decimals). */
    joinFee: bigint;
    /** The publisher's standing in the app (none, invited, active, suspended) */
    status: PublisherStatus;
    /** May publish now: active, on the current terms, and the app is live. */
    canPublish: boolean;
    /** The terms hash this publisher actually accepted, or zero. */
    acceptedTerms: Hex;
    /** The protocol admin has taken the whole app down — nobody can publish. */
    appSuspended: boolean;
}

/** What the upload gate needs to decide whether to serve a publisher under an app. */
export interface AppAccess {
    /** May publish to the app now (see `canPublish`). */
    canPublish: boolean;
    /** The app's owner, or the zero address for an unclaimed app. */
    owner: Address;
    /** Unix seconds the app's subscription expires at; 0 if unclaimed or cancelled. */
    expiresAt: bigint;
}

/** One `AppAgentChanged` event: an app owner pointed their app at a card. */
export interface AppAgentLog {
    appId: Hex;
    agentUri: string;
    blockNumber: bigint;
    transactionHash: Hash;
}

/** An app that has invited a publisher who has not joined it yet. */
export interface AppInvitation {
    appId: Hex;
    /** Who invited them. */
    owner: Address;
    /** The terms the publisher would accept by joining. */
    termsHash: Hex;
    termsUri: string;
    /** The join fee, in USDC base units (6 decimals). */
    joinFee: bigint;
    /** The app's agent card, or "" if its owner has not set one. */
    agentUri: string;
    /** The block the invitation was made in. */
    blockNumber: bigint;
}

/**
 * Blocks per `eth_getLogs` call for a query that names the contract and an
 * indexed topic. The public Arbitrum Sepolia endpoint serves such a query over
 * 10,000,000 blocks and no more (measured 2026-10-09); the explorer scans in
 * the same windows.
 */
const INDEXED_LOG_WINDOW = 10_000_000n;

/** True when the publisher joined but the app's terms have since changed. */
export function needsReacceptance(info: AppJoinInfo): boolean {
    return (
        info.status === PublisherStatus.ACTIVE &&
        info.acceptedTerms !== info.termsHash
    );
}

/**
 * Client for the AppRegistry's app management: apps and their ERC-5643
 * subscriptions, terms, per-app membership, the agent card, and the protocol
 * admin's powers. What an app presents — acceptances and exclusions — is the
 * registry's (`ChainRegistry`), not this client's.
 *
 * Scoped to one app, which may be unset: then only the calls that take no app work.
 */
export class AppRegistryClient {
    constructor(
        private contractAddress: Address,
        private appId: Hex | undefined,
        private publicClient: PublicClient,
        private walletClient: WalletClient,
    ) { }

    getAppId(): Hex | undefined {
        return this.appId;
    }

    setAppId(appId: Hex | undefined): void {
        this.appId = appId;
    }

    getAddress(): Address {
        return this.contractAddress;
    }

    /** This client's app, or a clear error for a call that needs one. */
    private app(): Hex {
        if (!this.appId) throw new Error("no app chosen: pass `appId` to Fangorn.create() or call setAppId()");
        return this.appId;
    }

    /** The app's subscription token: an app's token id is its app id. */
    tokenId(appId: Hex = this.app()): bigint {
        return hexToBigInt(appId);
    }

    private executeWrite<F extends WriteName>(
        functionName: F,
        args: ContractFunctionArgs<typeof APP_REGISTRY_ABI, "payable" | "nonpayable", F>,
    ): Promise<Hash> {
        return sendWrite(
            this.publicClient,
            requireWallet(this.walletClient, functionName),
            this.contractAddress,
            APP_REGISTRY_ABI as unknown as Abi,
            functionName,
            args as readonly unknown[],
        );
    }

    private read<F extends ViewName>(
        functionName: F,
        args: ContractFunctionArgs<typeof APP_REGISTRY_ABI, "view" | "pure", F>,
    ): Promise<ContractFunctionReturnType<typeof APP_REGISTRY_ABI, "view" | "pure", F>> {
        // viem cannot narrow a generic function name; the signature above is the type check.
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: APP_REGISTRY_ABI,
            functionName,
            args,
        } as never) as never;
    }

    // ── Apps and their subscriptions ─────────────────────────────────────────

    /**
     * Claim this app, if nobody has. Claiming IS subscribing: it pays one period
     * of `subscriptionFee()` in USDC and mints the app's token to the caller.
     * `joinFee` is what publishers will pay to join, in USDC base units.
     *
     * The fee read now is approved and passed as the most the claim may cost,
     * so a fee raised in the meantime makes the claim revert instead of charging
     * more.
     */
    async registerApp(termsHash: Hex, termsUri: string, joinFee = 0n): Promise<Hash> {
        const fee = await this.subscriptionFee();
        await this.approveUsdc(fee);
        return this.executeWrite("registerApp", [this.app(), termsHash, termsUri, joinFee, fee]);
    }

    /**
     * Pay for one more period (the owner, or an address they approved for the
     * app's token). Allowed once less than a period is left; the period is added
     * to the current expiry, or to now if it has passed.
     *
     * The standard gives the contract no maximum-fee argument, so the allowance
     * is the cap: exactly the fee read now is approved.
     */
    async renewSubscription(): Promise<Hash> {
        const [renewable, period, fee] = await Promise.all([
            this.isRenewable(),
            this.subscriptionPeriod(),
            this.subscriptionFee(),
        ]);
        if (!renewable) {
            const expiry = await this.expiresAt();
            throw new Error(
                `app ${this.app()} cannot be renewed until less than one period is left — it expires ${new Date(Number(expiry) * 1000).toISOString()}`,
            );
        }
        await this.approveUsdc(fee);
        return this.executeWrite("renewSubscription", [this.tokenId(), period]);
    }

    /**
     * End this app's subscription now (owner only): the expiry becomes zero and
     * nothing is refunded. Until it is renewed the app accepts no heads or joins.
     */
    async cancelSubscription(): Promise<Hash> {
        return this.executeWrite("cancelSubscription", [this.tokenId()]);
    }

    /** Unix seconds this app's subscription expires at; 0 once cancelled. Reverts for an unclaimed app. */
    async expiresAt(appId: Hex = this.app()): Promise<bigint> {
        return this.read("expiresAt", [this.tokenId(appId)]);
    }

    /** True while less than one period is left, or the subscription has expired. */
    async isRenewable(): Promise<boolean> {
        return this.read("isRenewable", [this.tokenId()]);
    }

    /** How long one payment lasts, in seconds. */
    async subscriptionPeriod(): Promise<bigint> {
        return this.read("subscriptionPeriod", []);
    }

    /** What claiming or renewing an app costs, in USDC base units (6 decimals), not wei. */
    async subscriptionFee(): Promise<bigint> {
        return this.read("subscriptionFee", []);
    }

    /** The ERC-20 token (USDC) every fee is paid in. */
    async usdc(): Promise<Address> {
        return this.read("usdc", []);
    }

    async getAppOwner(appId: Hex = this.app()): Promise<Address> {
        return this.read("getAppOwner", [appId]);
    }

    /**
     * Publish new terms for this app.
     *
     * Every member must accept the new terms (`acceptUpdatedTerms`) in order to
     * publish again.
     */
    async setAppTerms(termsHash: Hex, termsUri: string): Promise<Hash> {
        return this.executeWrite("setAppTerms", [this.app(), termsHash, termsUri]);
    }

    /**
     * Point this app at its ERC-8004 agent card.
     *
     * Safe to call whenever the card moves. It is a separate field from the terms
     * URI for one reason: publishers are bound to `termsHash`, so anything sharing
     * that slot stops every publisher in the app the moment it changes (see
     * `needsReacceptance`). A card holds endpoints and pubkeys, which rotate.
     */
    async setAppAgentUri(agentUri: string): Promise<Hash> {
        return this.executeWrite("setAppAgentUri", [this.app(), agentUri]);
    }

    /** Set what joining this app costs, in USDC base units (owner only). */
    async setJoinFee(joinFee: bigint): Promise<Hash> {
        return this.executeWrite("setJoinFee", [this.app(), joinFee]);
    }

    /** Send the caller's collected join fees, from all their apps, to `to`. */
    async withdrawJoinFees(to: Address = this.senderAddress()): Promise<Hash> {
        return this.executeWrite("withdrawJoinFees", [to]);
    }

    /** Join fees paid to `owner`'s apps and not yet withdrawn, in USDC base units. */
    async joinFeesOwed(owner: Address = this.senderAddress()): Promise<bigint> {
        return this.read("joinFeesOwed", [owner]);
    }

    async isAppSuspended(): Promise<boolean> {
        return this.read("isAppSuspended", [this.app()]);
    }

    async appTerms(): Promise<Hex> {
        return this.read("appTerms", [this.app()]);
    }

    async appTermsUri(): Promise<string> {
        return this.read("appTermsUri", [this.app()]);
    }

    /** What joining this app costs, in USDC base units. */
    async joinFee(): Promise<bigint> {
        return this.read("joinFee", [this.app()]);
    }

    /** The agent card URI of this app, or of `appId`. Empty if none is set. */
    async appAgentUri(appId: Hex = this.app()): Promise<string> {
        return this.read("appAgentUri", [appId]);
    }

    // ── Membership ───────────────────────────────────────────────────────────

    /**
     * Invite a publisher to this app (owner only). An invitation, not a
     * membership: they still accept the terms and pay the join fee with
     * `joinApp()`. Nobody can join uninvited. Take back an invitation not yet
     * accepted with `revokeInvitation()`.
     */
    async invitePublisher(publisher: Address): Promise<Hash> {
        return this.executeWrite("invitePublisher", [this.app(), publisher]);
    }

    /** Take back an invitation the publisher has not accepted yet (owner only). */
    async revokeInvitation(publisher: Address): Promise<Hash> {
        return this.executeWrite("revokeInvitation", [this.app(), publisher]);
    }

    /**
     * Suspend a member from this app, or reinstate them (owner only). Only for
     * publishers who have joined; an owner cannot suspend themselves.
     */
    async setPublisherSuspended(publisher: Address, suspended: boolean): Promise<Hash> {
        return this.executeWrite("setPublisherSuspended", [this.app(), publisher, suspended]);
    }

    /**
     * Join this app as a publisher: accept its current terms and pay its join
     * fee in USDC. The app owner must have invited this wallet first
     * (`invitePublisher`). Once only: after a terms change, a member uses
     * `acceptUpdatedTerms()` instead.
     *
     * Exactly the join fee read now is approved and passed as the most the join
     * may cost.
     */
    async joinApp(): Promise<Hash> {
        const { termsHash, joinFee } = await this.joinTerms(this.senderAddress());
        await this.approveUsdc(joinFee);
        return this.executeWrite("joinApp", [this.app(), termsHash, joinFee]);
    }

    /**
     * `joinApp` as UNSIGNED transactions for `publisher` to sign in their own
     * wallet, in order: a USDC approval of exactly the join fee, left out when
     * their allowance already covers it, then the join.
     *
     * The join is only simulated when it comes alone: before its approval lands
     * it would revert for want of an allowance.
     */
    async prepareJoinApp(publisher: Address): Promise<PreparedTx[]> {
        const { termsHash, joinFee } = await this.joinTerms(publisher);
        const txs: PreparedTx[] = [];
        if (joinFee !== 0n) {
            const token = await this.usdc();
            const allowance = await this.publicClient.readContract({
                address: token,
                abi: erc20Abi,
                functionName: "allowance",
                args: [publisher, this.contractAddress],
            });
            if (allowance < joinFee) {
                txs.push(
                    await prepareWrite(
                        this.publicClient,
                        publisher,
                        token,
                        erc20Abi as unknown as Abi,
                        "approve",
                        [this.contractAddress, joinFee],
                        { fallbackGas: 200_000n },
                    ),
                );
            }
        }
        txs.push(
            await prepareWrite(
                this.publicClient,
                publisher,
                this.contractAddress,
                APP_REGISTRY_ABI as unknown as Abi,
                "joinApp",
                [this.app(), termsHash, joinFee],
                { fallbackGas: 1_000_000n, simulate: txs.length === 0 },
            ),
        );
        return txs;
    }

    /**
     * Accept this app's current terms after its owner changed them (free). For
     * members only; until they do, they cannot publish.
     */
    async acceptUpdatedTerms(): Promise<Hash> {
        return this.executeWrite("acceptUpdatedTerms", [this.app(), await this.appTerms()]);
    }

    /**
     * May `publisher` publish to this app now: active, on the current terms, not
     * banned network-wide, and the app is live and paid up.
     */
    async canPublish(publisher: Address, appId: Hex = this.app()): Promise<boolean> {
        return this.read("canPublish", [appId, publisher]);
    }

    /** The single oracle the upload gate reads for one publisher under this app. */
    async access(publisher: Address, appId: Hex = this.app()): Promise<AppAccess> {
        const [canPublish, owner, expiresAt] = await this.read("access", [appId, publisher]);
        return { canPublish, owner, expiresAt };
    }

    async acceptedTerms(publisher: Address): Promise<Hex> {
        return this.read("acceptedTerms", [this.app(), publisher]);
    }

    async joinInfo(publisher: Address): Promise<AppJoinInfo> {
        const [tuple, acceptedTerms, appSuspended] = await Promise.all([
            this.read("joinInfo", [this.app(), publisher]),
            this.acceptedTerms(publisher),
            this.isAppSuspended(),
        ]);
        const [termsHash, termsUri, joinFee, status, canPublish] = tuple;
        return {
            termsHash,
            termsUri,
            joinFee,
            status: status as PublisherStatus,
            canPublish,
            acceptedTerms,
            appSuspended,
        };
    }

    /**
     * The apps that have invited `publisher` and are still waiting for them to
     * join (`joinApp`), oldest invitation first.
     *
     * The contract cannot list a publisher's apps, so this reads the
     * `PublisherInvited` logs that name the publisher, the way the explorer reads
     * `AppAgentChanged` to find apps. A log says an invitation was made, not that
     * it still stands, so each app's current status is then read from the
     * contract: an invitation that was accepted or revoked is left out.
     *
     * `fromBlock` is the AppRegistry's deploy block (`appRegistryFromBlock` in the
     * config). Doesn't touch this client's app.
     */
    async getInvitations(
        publisher: Address,
        opts: { fromBlock: bigint; toBlock?: bigint },
    ): Promise<AppInvitation[]> {
        const logs = await getLogsInWindows(
            this.publicClient,
            opts.fromBlock,
            opts.toBlock,
            (from, to) =>
                this.publicClient.getContractEvents({
                    address: this.contractAddress,
                    abi: APP_REGISTRY_ABI,
                    eventName: "PublisherInvited",
                    args: { publisher },
                    fromBlock: from,
                    toBlock: to,
                    strict: true,
                }),
            INDEXED_LOG_WINDOW,
        );
        // A revoked invitation can be made again; the latest log for an app wins.
        const invitedAt = new Map(logs.map((log) => [log.args.app_id, log.blockNumber]));
        const invitations = await Promise.all(
            [...invitedAt].map(async ([appId, blockNumber]): Promise<AppInvitation | undefined> => {
                const [[termsHash, termsUri, joinFee, status], owner, agentUri] = await Promise.all([
                    this.read("joinInfo", [appId, publisher]),
                    this.getAppOwner(appId),
                    this.appAgentUri(appId),
                ]);
                if ((status as PublisherStatus) !== PublisherStatus.INVITED) return undefined;
                return { appId, owner, termsHash, termsUri, joinFee, agentUri, blockNumber };
            }),
        );
        return invitations
            .filter((invitation) => invitation !== undefined)
            .sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0));
    }

    // ── Logs ─────────────────────────────────────────────────────────────────

    /**
     * `AppAgentChanged` events, oldest first. The last one for an app is its
     * current card; an empty `agentUri` means the owner unset it.
     *
     * Leave `appId` out to list every app that has ever set a card. The chain is
     * the directory: one windowed log scan, no indexer and no registry namespace.
     * `fromBlock` is required because scanning from genesis on an L2 costs
     * hundreds of thousands of RPC calls. Pass the AppRegistry's deploy block, or
     * a block you know to be before the app's registration.
     */
    async getAppAgentLogs(opts: {
        appId?: Hex;
        fromBlock: bigint;
        toBlock?: bigint;
    }): Promise<AppAgentLog[]> {
        const logs = await getLogsInWindows(this.publicClient, opts.fromBlock, opts.toBlock, (from, to) =>
            this.publicClient.getContractEvents({
                address: this.contractAddress,
                abi: APP_REGISTRY_ABI,
                eventName: "AppAgentChanged",
                args: opts.appId ? { app_id: opts.appId } : {},
                fromBlock: from,
                toBlock: to,
                strict: true,
            }),
        );
        return logs.map((log) => ({
            appId: log.args.app_id,
            agentUri: log.args.agent_uri,
            blockNumber: log.blockNumber,
            transactionHash: log.transactionHash,
        }));
    }

    // ── Protocol admin ───────────────────────────────────────────────────────

    async admin(): Promise<Address> {
        return this.read("admin", []);
    }

    /** The DataRegistry whose heads this contract accepts. */
    async dataRegistry(): Promise<Address> {
        return this.read("dataRegistry", []);
    }

    /** Whether the protocol admin has banned `wallet` network-wide. */
    async isGloballySuspended(wallet: Address): Promise<boolean> {
        return this.read("globalSuspensions", [wallet]);
    }

    /**
     * Ban `wallet` network-wide, or lift the ban. A banned wallet cannot claim an
     * app or join one, and reads as an exclusion in every app; a banned owner's app keeps running, but they
     * cannot invite anyone or change its terms or agent card.
     */
    async setGlobalSuspension(wallet: Address, suspended: boolean): Promise<Hash> {
        return this.executeWrite("setGlobalSuspension", [wallet, suspended]);
    }

    /** Take this app down for every publisher at once, or restore it. */
    async setAppSuspended(suspended: boolean): Promise<Hash> {
        return this.executeWrite("setAppSuspended", [this.app(), suspended]);
    }

    async setDataRegistry(registry: Address): Promise<Hash> {
        return this.executeWrite("setDataRegistry", [registry]);
    }

    async setSubscriptionFee(fee: bigint): Promise<Hash> {
        return this.executeWrite("setSubscriptionFee", [fee]);
    }

    /** Applies from each app's next payment. */
    async setSubscriptionPeriod(period: bigint): Promise<Hash> {
        return this.executeWrite("setSubscriptionPeriod", [period]);
    }

    /**
     * Send `amount` of `token` to `to`. Of USDC, only the protocol's share: what
     * app owners are owed in join fees stays (`ExceedsProtocolBalance`).
     */
    async withdrawToken(token: Address, to: Address, amount: bigint): Promise<Hash> {
        return this.executeWrite("withdrawToken", [token, to, amount]);
    }

    // ── Internals ────────────────────────────────────────────────────────────

    /**
     * Fees are pulled with `transferFrom`, so the registry needs an allowance.
     * Without one the call reverts with a fee error that reads like a pricing
     * problem but is really an allowance one. Approves exactly `amount`.
     */
    private async approveUsdc(amount: bigint): Promise<void> {
        if (amount === 0n) return;
        const token = await this.usdc();
        const allowance = await this.publicClient.readContract({
            address: token,
            abi: erc20Abi,
            functionName: "allowance",
            args: [this.senderAddress(), this.contractAddress],
        });
        if (allowance >= amount) return;
        await sendWrite(
            this.publicClient,
            requireWallet(this.walletClient, "approve"),
            token,
            erc20Abi as unknown as Abi,
            "approve",
            [this.contractAddress, amount],
        );
    }

    /** The terms hash and join fee a join must carry, or why `publisher` cannot join. */
    private async joinTerms(publisher: Address): Promise<{ termsHash: Hex; joinFee: bigint }> {
        const [[termsHash, , joinFee, status], { expiresAt }, block] = await Promise.all([
            this.read("joinInfo", [this.app(), publisher]),
            this.access(publisher),
            this.publicClient.getBlock(),
        ]);
        if (termsHash === ZERO_HASH) {
            throw new Error(
                `app ${this.app()} has published no terms — it cannot be joined until its owner sets them`,
            );
        }
        switch (status as PublisherStatus) {
            case PublisherStatus.NONE:
                throw new Error(
                    `${publisher} has not been invited to app ${this.app()} — its owner must invite them (invitePublisher) before they can join`,
                );
            case PublisherStatus.SUSPENDED:
                throw new Error(`${publisher} is suspended from app ${this.app()}`);
            case PublisherStatus.ACTIVE:
                throw new Error(
                    `${publisher} has already joined app ${this.app()} — after a terms change, use acceptUpdatedTerms`,
                );
        }
        if (expiresAt <= block.timestamp) {
            throw new Error(`app ${this.app()}'s subscription has expired — it takes no joins until renewed`);
        }
        return { termsHash, joinFee };
    }

    private senderAddress(): Address {
        const account = this.walletClient.account;
        if (!account) throw new Error("Account required");
        return account.address;
    }
}

const ZERO_HASH: Hex = `0x${"0".repeat(64)}`;
