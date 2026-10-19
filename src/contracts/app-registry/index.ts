import {
    ContractFunctionArgs,
    ContractFunctionName,
    erc20Abi,
    type Abi,
    type Address,
    type Hash,
    type Hex,
    type PublicClient,
    type WalletClient,
} from "viem";

import { APP_REGISTRY_ABI } from "./abi.js";
import { requireWallet, sendWrite } from "../write.js";
import { getLogsInWindows } from "../logs.js";
import { prepareTx, type PreparedTx } from "../data-registry/index.js";
import { PublisherStatus } from "../types.js";

/**
 * The information required of a publisher in order to join an app
 */
export interface AppJoinInfo {
    /** The app's terms hash (zero means no terms); e.g. an IPFS cid  */
    termsHash: Hex;
    /** A uri pointing to the terms: e.g. an IPFS gateway+CID */
    termsUri: string;
    /** publisher defined joiners fee */
    fee: bigint;
    /** app publisher status (active, unregistered, suspended) */
    status: PublisherStatus;
    /** Active AND up-to-date with term agreements */
    registered: boolean;
    // what is this? is it needed? I don't like it
    /** The terms hash this publisher actually accepted, or zero. */
    acceptedTerms: Hex;
    /** The protocol admin has taken the whole app down — nobody is registered. */
    appSuspended: boolean;
}

/** What the upload gate reads to decide whether to bill a publisher's bytes to an app. */
export interface AppAccess {
    /** A joined publisher on the app's current terms, in a live, paid-up app. */
    canPublish: boolean;
    /** The app's owner, or the zero address for an unclaimed app. */
    owner: Address;
    /** Unix seconds when the app's subscription lapses; 0 once cancelled. */
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
    /** The join fee, in USDC base units. */
    fee: bigint;
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
        !info.registered &&
        info.status === PublisherStatus.ACTIVE &&
        info.acceptedTerms !== info.termsHash
    );
}

/**
 * Client for the AppRegistry's app management: claiming an app (its storage
 * subscription), terms, membership, the agent card, and the protocol admin's
 * powers. What an app presents — acceptances and exclusions — is the registry's
 * (`ChainRegistry`), not this client's.
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

    private executeWrite<
        TFunctionName extends ContractFunctionName<typeof APP_REGISTRY_ABI, "payable" | "nonpayable">
    >(
        functionName: TFunctionName,
        args: ContractFunctionArgs<typeof APP_REGISTRY_ABI, "payable" | "nonpayable", TFunctionName>,
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

    private read<TFunctionName extends ContractFunctionName<typeof APP_REGISTRY_ABI, "pure" | "view">>(
        functionName: TFunctionName,
        args: ContractFunctionArgs<typeof APP_REGISTRY_ABI, "pure" | "view", TFunctionName>,
    ) {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: APP_REGISTRY_ABI,
            functionName,
            args,
        } as never) as Promise<never>;
    }

    /**
     * Claim this app, if nobody has. Claiming IS subscribing: the contract pulls
     * `subscriptionFee()` in USDC, approved here first when the allowance is short.
     * `joinFee` is what each publisher pays to join, in USDC base units. The
     * claimer becomes the app's first publisher.
     *
     * A wallet the protocol admin has banned reverts `PublisherSuspendedGlobal`.
     */
    async registerApp(termsHash: Hex, termsUri: string, joinFee = 0n): Promise<Hash> {
        const fee = await this.subscriptionFee();
        await this.approve(fee);
        return this.executeWrite("registerApp", [this.app(), termsHash, termsUri, joinFee, fee]);
    }

    /** Pay for one more period (owner, once less than a period is left). */
    async renewApp(): Promise<Hash> {
        const [fee, period] = await Promise.all([this.subscriptionFee(), this.subscriptionPeriod()]);
        await this.approve(fee);
        return this.executeWrite("renewSubscription", [BigInt(this.app()), period]);
    }

    /**
     * Invite a publisher (owner only). An invitation, not a membership: they still
     * accept the terms and pay the join fee with `registerForApp()`.
     */
    async addPublisher(publisher: Address): Promise<Hash> {
        return this.executeWrite("invitePublisher", [this.app(), publisher]);
    }

    /**
     * Fees are pulled with `transferFrom`, so the registry needs an allowance.
     * Without one the call reverts `SubscriptionFeeRequired` / `JoinFeeRequired`,
     * which reads like a pricing error but is really an allowance one.
     */
    private async approve(amount: bigint): Promise<void> {
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

    /** Publish new terms. Every member must accept them before their heads are accepted again. */
    async setAppTerms(termsHash: Hex, termsUri: string): Promise<Hash> {
        return this.executeWrite("setAppTerms", [this.app(), termsHash, termsUri]);
    }

    /**
     * Point this app at its ERC-8004 agent card.
     *
     * Safe to call whenever the card moves. It is a separate field from the terms
     * URI for one reason: publishers are bound to `termsHash`, so anything sharing
     * that slot drops every member the moment it changes (see `needsReacceptance`).
     */
    async setAppAgentUri(agentUri: string): Promise<Hash> {
        return this.executeWrite("setAppAgentUri", [this.app(), agentUri]);
    }

    /** Set the join fee, in USDC base units. */
    async setAppFee(fee: bigint): Promise<Hash> {
        return this.executeWrite("setJoinFee", [this.app(), fee]);
    }

    /** Suspend a member (owner only): its new heads stop being accepted. */
    async suspendForApp(publisher: Address): Promise<Hash> {
        return this.executeWrite("setPublisherSuspended", [this.app(), publisher, true]);
    }

    async reinstateForApp(publisher: Address): Promise<Hash> {
        return this.executeWrite("setPublisherSuspended", [this.app(), publisher, false]);
    }

    /** Admin: take the whole app down. */
    async suspendApp(): Promise<Hash> {
        return this.executeWrite("setAppSuspended", [this.app(), true]);
    }

    async reinstateApp(): Promise<Hash> {
        return this.executeWrite("setAppSuspended", [this.app(), false]);
    }

    /** Admin: ban a wallet network-wide, or lift the ban. */
    async setBanned(publisher: Address, banned: boolean): Promise<Hash> {
        return this.executeWrite("setGlobalSuspension", [publisher, banned]);
    }

    /** Whether the protocol admin has banned this wallet network-wide. */
    async isBanned(publisher: Address): Promise<boolean> {
        return this.read("globalSuspensions", [publisher]);
    }

    async admin(): Promise<Address> {
        return this.read("admin", []);
    }

    /**
     * Join this app as a publisher: accept its current terms and pay its join fee
     * (USDC, approved here first). The owner must have invited this wallet. A
     * member whose terms the owner has since replaced accepts the new ones instead,
     * for free.
     */
    async registerForApp(): Promise<Hash> {
        const { termsHash, fee, status } = await this.joinTerms(this.senderAddress());
        if (status === PublisherStatus.ACTIVE) return this.executeWrite("acceptUpdatedTerms", [this.app(), termsHash]);
        await this.approve(fee);
        return this.executeWrite("joinApp", [this.app(), termsHash, fee]);
    }

    /**
     * The join as an unsigned tx for `publisher`'s wallet. A non-zero join fee also
     * needs a USDC approval from that wallet first.
     */
    async prepareRegisterForApp(publisher: Address): Promise<PreparedTx> {
        const { termsHash, fee } = await this.joinTerms(publisher);
        return prepareTx(this.publicClient, publisher, this.contractAddress, APP_REGISTRY_ABI as unknown as Abi, "joinApp", [
            this.app(),
            termsHash,
            fee,
        ]);
    }

    async getAppOwner(appId: Hex = this.app()): Promise<Address> {
        return this.read("getAppOwner", [appId]);
    }

    /** May `publisher` have its heads accepted into the app, and its uploads billed to it? */
    async isRegisteredForApp(publisher: Address, appId: Hex = this.app()): Promise<boolean> {
        return this.read("canPublish", [appId, publisher]);
    }

    /** The single oracle the upload gate reads for one publisher under this app. */
    async access(publisher: Address, appId: Hex = this.app()): Promise<AppAccess> {
        const [canPublish, owner, expiresAt] = (await this.read("access", [appId, publisher])) as readonly [
            boolean,
            Address,
            bigint,
        ];
        return { canPublish, owner, expiresAt };
    }

    /** Unix seconds when this app's subscription lapses (0 once cancelled). */
    async expiresAt(): Promise<bigint> {
        return BigInt(await this.read("expiresAt", [BigInt(this.app())]));
    }

    /** What claiming or renewing an app costs, in USDC's smallest unit (6 decimals). */
    async subscriptionFee(): Promise<bigint> {
        return this.read("subscriptionFee", []);
    }

    /** Seconds one subscription payment lasts. */
    async subscriptionPeriod(): Promise<bigint> {
        return BigInt(await this.read("subscriptionPeriod", []));
    }

    /** The ERC-20 token (USDC) fees are paid in. */
    async usdc(): Promise<Address> {
        return this.read("usdc", []);
    }

    /** The DataRegistry whose heads this contract accepts. */
    async dataRegistry(): Promise<Address> {
        return this.read("dataRegistry", []);
    }

    // ── Protocol admin ───────────────────────────────────────────────────────

    async setDataRegistry(registry: Address): Promise<Hash> {
        return this.executeWrite("setDataRegistry", [registry]);
    }

    async setSubscriptionFee(fee: bigint): Promise<Hash> {
        return this.executeWrite("setSubscriptionFee", [fee]);
    }

    /** The protocol's share of the USDC the contract holds; owners' join fees are out of reach. */
    async withdrawUsdc(to: Address, amount: bigint): Promise<Hash> {
        return this.executeWrite("withdrawToken", [await this.usdc(), to, amount]);
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

    /** The agent card URI of this app, or of `appId`. Empty if none is set. */
    async appAgentUri(appId: Hex = this.app()): Promise<string> {
        return this.read("appAgentUri", [appId]);
    }
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

    /**
     * The apps that have invited `publisher` and are still waiting for them to
     * join (`registerForApp`), oldest invitation first.
     *
     * The contract cannot list a publisher's apps, so this reads the
     * `PublisherInvited` logs that name the publisher, the way the explorer reads
     * `AppAgentChanged` to find apps. A log says an invitation was made, not that
     * it still stands, so each app's current status is then read from the
     * contract: an invitation that was accepted or taken back is left out.
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
        // Oldest first. A revoked invitation can be re-sent, so later blocks win.
        const invitedAt = new Map(logs.map((log) => [log.args.app_id, log.blockNumber]));
        const invitations = await Promise.all(
            [...invitedAt].map(async ([appId, blockNumber]): Promise<AppInvitation | undefined> => {
                const [[termsHash, termsUri, fee, status], owner, agentUri] = await Promise.all([
                    this.readJoinInfoTuple(publisher, appId),
                    this.getAppOwner(appId),
                    this.appAgentUri(appId),
                ]);
                if ((status as PublisherStatus) !== PublisherStatus.INVITED) return undefined;
                return { appId, owner, termsHash, termsUri, fee, agentUri, blockNumber };
            }),
        );
        return invitations.filter((invitation) => invitation !== undefined);
    }

    /** The join fee, in USDC base units. */
    async appFee(): Promise<bigint> {
        return this.read("joinFee", [this.app()]);
    }

    async acceptedTerms(publisher: Address): Promise<Hex> {
        return this.read("acceptedTerms", [this.app(), publisher]);
    }

    async joinInfo(publisher: Address): Promise<AppJoinInfo> {
        const [tuple, acceptedTerms, appSuspended] = await Promise.all([
            this.readJoinInfoTuple(publisher),
            this.acceptedTerms(publisher),
            this.isAppSuspended(),
        ]);
        const [termsHash, termsUri, fee, status, registered] = tuple;
        return {
            termsHash,
            termsUri,
            fee,
            status: status as PublisherStatus,
            registered,
            acceptedTerms,
            appSuspended,
        };
    }

    /** The terms hash and fee a join must carry, or why `publisher` cannot join. */
    private async joinTerms(publisher: Address): Promise<{ termsHash: Hex; fee: bigint; status: PublisherStatus }> {
        const [termsHash, , fee, status] = await this.readJoinInfoTuple(publisher);
        if (termsHash === ZERO_HASH) {
            throw new Error(
                `app ${this.app()} has published no terms — it cannot be joined until its owner sets them`,
            );
        }
        if ((status as PublisherStatus) === PublisherStatus.UNREGISTERED) {
            throw new Error(
                `${publisher} has not been added to app ${this.app()} — its owner must add them (addPublisher) before they can join`,
            );
        }
        return { termsHash, fee, status: status as PublisherStatus };
    }

    private async readJoinInfoTuple(
        publisher: Address,
        appId: Hex = this.app(),
    ): Promise<readonly [Hex, string, bigint, number, boolean]> {
        return this.read("joinInfo", [appId, publisher]);
    }

    private senderAddress(): Address {
        const account = this.walletClient.account;
        if (!account) throw new Error("Account required");
        return account.address;
    }
}

const ZERO_HASH: Hex = `0x${"0".repeat(64)}`;
