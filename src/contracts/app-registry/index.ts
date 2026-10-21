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
import { requireWallet, sendWrite } from "../write.js";
import { getLogsInWindows } from "../logs.js";
import { PublisherStatus } from "../types.js";

export type { PreparedTx } from "../write.js";

type ViewName = ContractFunctionName<typeof APP_REGISTRY_ABI, "view" | "pure">;
type WriteName = ContractFunctionName<typeof APP_REGISTRY_ABI, "payable" | "nonpayable">;

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

/**
 * Client for the AppRegistry's app management: apps and their ERC-5643
 * subscriptions, the publishers each app accepts, the agent card, and the
 * protocol admin's powers. What an app presents — its members, less exclusions — is
 * read through the registry (`ChainRegistry`), not this client.
 *
 * Scoped to one app, which may be unset: then only the calls that take no app work.
 */
export class AppRegistryClient {
    constructor(
        private contractAddress: Address,
        private appId: Hex | undefined,
        private publicClient: PublicClient,
        private walletClient: WalletClient,
        // The network's `AppConfig.logWindow`: the most blocks one getLogs may span.
        private logWindow?: bigint,
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
     * of `subscriptionFee()` in USDC and mints the app's token to the caller,
     * who becomes the app's first accepted publisher.
     *
     * The fee read now is approved and passed as the most the claim may cost,
     * so a fee raised in the meantime makes the claim revert instead of charging
     * more.
     */
    async registerApp(): Promise<Hash> {
        const fee = await this.subscriptionFee();
        await this.approveUsdc(fee);
        return this.executeWrite("registerApp", [this.app(), fee]);
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
     * nothing is refunded. Until it is renewed the app provides no storage and includes nothing.
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
     * Point this app at its ERC-8004 agent card.
     *
     * Safe to call whenever the card moves: it leaves the app's publishers alone.
     */
    async setAppAgentUri(agentUri: string): Promise<Hash> {
        return this.executeWrite("setAppAgentUri", [this.app(), agentUri]);
    }

    /** Send the join fees the caller is still owed, from the old join flow, to `to`. */
    async withdrawJoinFees(to: Address = this.senderAddress()): Promise<Hash> {
        return this.executeWrite("withdrawJoinFees", [to]);
    }

    /** Join fees still owed to `owner` from the old join flow, in USDC base units. Nothing adds to it. */
    async joinFeesOwed(owner: Address = this.senderAddress()): Promise<bigint> {
        return this.read("joinFeesOwed", [owner]);
    }

    async isAppSuspended(): Promise<boolean> {
        return this.read("isAppSuspended", [this.app()]);
    }

    /** The agent card URI of this app, or of `appId`. Empty if none is set. */
    async appAgentUri(appId: Hex = this.app()): Promise<string> {
        return this.read("appAgentUri", [appId]);
    }

    // ── Publishers ───────────────────────────────────────────────────────────

    /**
     * Accept a publisher into this app (owner only). That is the whole
     * membership: from here it uploads with storage the app provides, and the app
     * includes its data, while `canPublish` holds. A suspended publisher comes
     * back with `setPublisherSuspended(publisher, false)`.
     */
    async acceptPublisher(publisher: Address): Promise<Hash> {
        return this.executeWrite("acceptPublisher", [this.app(), publisher]);
    }

    /**
     * Suspend an accepted publisher from this app, or reinstate them (owner
     * only). An owner cannot suspend themselves.
     */
    async setPublisherSuspended(publisher: Address, suspended: boolean): Promise<Hash> {
        return this.executeWrite("setPublisherSuspended", [this.app(), publisher, suspended]);
    }

    /** `publisher`'s standing in this app. */
    async status(publisher: Address): Promise<PublisherStatus> {
        return (await this.read("statusForApp", [this.app(), publisher])) as PublisherStatus;
    }

    /**
     * May `publisher` publish to this app now: accepted and not suspended, not
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
            this.logWindow,
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

    /** The DataRegistry this contract names. */
    async dataRegistry(): Promise<Address> {
        return this.read("dataRegistry", []);
    }

    /** Whether the protocol admin has banned `wallet` network-wide. */
    async isGloballySuspended(wallet: Address): Promise<boolean> {
        return this.read("globalSuspensions", [wallet]);
    }

    /**
     * Ban `wallet` network-wide, or lift the ban. A banned wallet cannot claim an
     * app or be accepted into one, and no app stores or includes it; a banned
     * owner's app keeps running, but they cannot accept anyone or move its agent card.
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

    private senderAddress(): Address {
        const account = this.walletClient.account;
        if (!account) throw new Error("Account required");
        return account.address;
    }
}

