import {
    ContractFunctionArgs,
    ContractFunctionName,
    encodeFunctionData,
    erc20Abi,
    type Abi,
    toHex,
    type Address,
    type Hash,
    type Hex,
    type PublicClient,
    type WalletClient,
} from "viem";

import { APP_REGISTRY_ABI } from "./abi.js";
import { requireWallet, sendWrite } from "../write.js";
import { getLogsInWindows } from "../logs.js";
import type { PreparedTx } from "../data-registry/index.js";
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

/** What the upload gate needs to decide whether to serve a publisher under an app. */
export interface AppAccess {
    /** An active publisher of the app, on its current terms. */
    registered: boolean;
    /** The app's owner, or the zero address for an unclaimed app. */
    owner: Address;
    /** Unix seconds of the app's last subscription payment, or 0 if unclaimed. */
    paidAt: bigint;
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
    /** Who invited them. Any app owner can invite any registered wallet. */
    owner: Address;
    /** The terms the publisher would accept by joining. */
    termsHash: Hex;
    termsUri: string;
    /** The join fee, in wei. */
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
 * Client for the AppRegistry
 */
export class AppRegistryClient {
    constructor(
        private contractAddress: Address,
        private appId: Hex,
        private publicClient: PublicClient,
        private walletClient: WalletClient,
    ) { }

    getAppId(): Hex {
        return this.appId;
    }

    setAppId(appId: Hex): void {
        this.appId = appId;
    }

    getAddress(): Address {
        return this.contractAddress;
    }

    // call the contract
    private executeWrite<
        TFunctionName extends ContractFunctionName<typeof APP_REGISTRY_ABI, "payable" | "nonpayable">
    >(
        functionName: TFunctionName,
        args: ContractFunctionArgs<typeof APP_REGISTRY_ABI, "payable" | "nonpayable", TFunctionName>,
        value?: bigint,
    ): Promise<Hash> {
        return sendWrite(
            this.publicClient,
            requireWallet(this.walletClient, functionName),
            this.contractAddress,
            APP_REGISTRY_ABI as unknown as Abi,
            functionName,
            args as readonly unknown[],
            value,
        );
    }

    /**
     * try to register an app (if it has not been claimed)
     *
     * Claiming an app IS subscribing: the contract pulls `subscriptionFee()` in
     * USDC, so this approves it first when the allowance is short. `fee` is the
     * app's own join fee (wei), not the subscription.
     *
     * The caller must already be registered in the DataRegistry
     * (`DataRegistryClient.register()`), or the claim reverts
     * `NotRegisteredGlobally`.
     */
    async registerApp(termsHash: Hex, termsUri: string, fee = 0n): Promise<Hash> {
        await this.approveSubscriptionFee();
        return this.executeWrite("registerApp", [this.appId, termsHash, termsUri, fee]);
    }

    /**
     * Renew this app's subscription (owner only): pays the fee again and
     * re-stamps the payment time. Renewing early loses nothing.
     */
    async renewApp(): Promise<Hash> {
        await this.approveSubscriptionFee();
        return this.executeWrite("renewApp", [this.appId]);
    }

    /**
     * Add a publisher to this app (owner only). An invitation, not a membership:
     * they still accept the terms and pay the join fee with `registerForApp()`.
     * Nobody can join uninvited. Take it back with `suspendForApp()`.
     *
     * The publisher must already be registered in the DataRegistry — never
     * registered, or banned by the protocol admin, reverts `NotRegisteredGlobally`.
     */
    async addPublisher(publisher: Address): Promise<Hash> {
        return this.executeWrite("addPublisher", [this.appId, publisher]);
    }

    /**
     * The subscription fee is pulled with `transferFrom`, so the registry needs an
     * allowance for it. Without one the call reverts `SubscriptionFeeRequired`,
     * which reads like a pricing error but is really an allowance one.
     */
    private async approveSubscriptionFee(): Promise<void> {
        const [fee, token] = await Promise.all([this.subscriptionFee(), this.usdc()]);
        if (fee === 0n) return;
        const allowance = await this.publicClient.readContract({
            address: token,
            abi: erc20Abi,
            functionName: "allowance",
            args: [this.senderAddress(), this.contractAddress],
        });
        if (allowance >= fee) return;
        await sendWrite(
            this.publicClient,
            requireWallet(this.walletClient, "approve"),
            token,
            erc20Abi as unknown as Abi,
            "approve",
            [this.contractAddress, fee],
        );
    }

    /**
     * Publish new terms for this app.
     *
     * Every registered must accept the new terms in order to publish again
     */
    async setAppTerms(termsHash: Hex, termsUri: string): Promise<Hash> {
        return this.executeWrite("setAppTerms", [this.appId, termsHash, termsUri]);
    }

    /**
     * Point this app at its ERC-8004 agent card.
     *
     * Safe to call whenever the card moves. It is a separate field from the terms
     * URI for one reason: publishers are bound to `termsHash`, so anything sharing
     * that slot unregisters every publisher in the app the moment it changes (see
     * `needsReacceptance`). A card holds endpoints and pubkeys, which rotate.
     */
    async setAppAgentUri(agentUri: string): Promise<Hash> {
        return this.executeWrite("setAppAgentUri", [this.appId, agentUri]);
    }

    async setAppFee(fee: bigint): Promise<Hash> {
        return this.executeWrite("setAppFee", [this.appId, fee]);
    }

    /**
     * Suspend a publisher from this app
     * only callable by the app owner
     */
    async suspendForApp(publisher: Address): Promise<Hash> {
        return this.executeWrite("suspendForApp", [this.appId, publisher]);
    }

    async reinstateForApp(publisher: Address): Promise<Hash> {
        return this.executeWrite("reinstateForApp", [this.appId, publisher]);
    }

    /**
     * Suspend an app and all publish capabilities
     */
    async suspendApp(): Promise<Hash> {
        return this.executeWrite("suspendApp", [this.appId]);
    }

    async reinstateApp(): Promise<Hash> {
        return this.executeWrite("reinstateApp", [this.appId]);
    }

    async admin(): Promise<Address> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: APP_REGISTRY_ABI,
            functionName: "admin",
        });
    }

    /**
     * Register as a publisher within an app
     * Registration = accepting its current terms. The app owner must have added
     * this wallet first (`addPublisher`).
     */
    async registerForApp(): Promise<Hash> {
        const { termsHash, fee } = await this.joinTerms(this.senderAddress());
        return this.executeWrite("registerForApp", [this.appId, termsHash], fee);
    }

    /**
     * prepare the tx to register as a publisher for an app
     */
    async prepareRegisterForApp(publisher: Address): Promise<PreparedTx & { value: Hex }> {
        const { termsHash, fee } = await this.joinTerms(publisher);

        const data = encodeFunctionData({
            abi: APP_REGISTRY_ABI,
            functionName: "registerForApp",
            args: [this.appId, termsHash],
        });

        // Fees and gas quoted here rather than left to the wallet, for the reasons
        // in prepareCommitStateRoot: wallet estimation runs tight against a live L2
        // base fee and surfaces as "Network fee Unavailable" in MetaMask.
        const fees = await this.publicClient.estimateFeesPerGas();

        let gas: bigint;
        try {
            const estimate = await this.publicClient.estimateGas({
                account: publisher,
                to: this.contractAddress,
                data,
                value: fee,
            });
            gas = (estimate * 3n) / 2n;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (/revert/i.test(message)) {
                throw new Error(
                    `joining would revert — this wallet may not have been added by the app owner, may already be registered, or is suspended from this app: ${message}`,
                );
            }
            // e.g. rpc hiccup
            gas = 1_000_000n;
        }

        return {
            to: this.contractAddress,
            data,
            chainId: this.publicClient.chain?.id,
            gas: toHex(gas),
            maxFeePerGas: toHex(fees.maxFeePerGas * 2n),
            maxPriorityFeePerGas: toHex(fees.maxPriorityFeePerGas),
            value: toHex(fee),
        };
    }

    async getAppOwner(appId: Hex = this.appId): Promise<Address> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: APP_REGISTRY_ABI,
            functionName: "getAppOwner",
            args: [appId],
        });
    }

    async isRegisteredForApp(publisher: Address): Promise<boolean> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: APP_REGISTRY_ABI,
            functionName: "isRegisteredForApp",
            args: [this.appId, publisher],
        });
    }

    /** The single oracle the upload gate reads for one publisher under this app. */
    async access(publisher: Address): Promise<AppAccess> {
        const [registered, owner, paidAt] = await this.publicClient.readContract({
            address: this.contractAddress,
            abi: APP_REGISTRY_ABI,
            functionName: "access",
            args: [this.appId, publisher],
        });
        return { registered, owner, paidAt };
    }

    /**
     * Whether this app's subscription is inside `windowSeconds` of its last
     * payment. The contract stores only the timestamp; the window is the gate's
     * policy, passed in here. `now` is injectable so a caller can evaluate
     * against block time rather than wall-clock skew.
     */
    async isActiveAt(
        windowSeconds: bigint,
        now = BigInt(Math.floor(Date.now() / 1000)),
    ): Promise<boolean> {
        const paidAt = await this.subscribedAt();
        return paidAt > 0n && now < paidAt + windowSeconds;
    }

    /** Unix seconds of this app's last subscription payment, or 0 if unclaimed. */
    async subscribedAt(): Promise<bigint> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: APP_REGISTRY_ABI,
            functionName: "subscribedAt",
            args: [this.appId],
        });
    }

    /** What claiming or renewing an app costs, in USDC's smallest unit (6 decimals), not wei. */
    async subscriptionFee(): Promise<bigint> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: APP_REGISTRY_ABI,
            functionName: "subscriptionFee",
        });
    }

    /** The ERC-20 token (USDC) the subscription fee is paid in. */
    async usdc(): Promise<Address> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: APP_REGISTRY_ABI,
            functionName: "usdc",
        });
    }

    /** The DataRegistry this contract asks whether a wallet is a registered publisher. */
    async dataRegistry(): Promise<Address> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: APP_REGISTRY_ABI,
            functionName: "dataRegistry",
        });
    }

    // ── Protocol admin ───────────────────────────────────────────────────────

    async setDataRegistry(registry: Address): Promise<Hash> {
        return this.executeWrite("setDataRegistry", [registry]);
    }

    async setSubscriptionFee(fee: bigint): Promise<Hash> {
        return this.executeWrite("setSubscriptionFee", [fee]);
    }

    async setUsdc(token: Address): Promise<Hash> {
        return this.executeWrite("setUsdc", [token]);
    }

    async withdrawUsdc(to: Address, amount: bigint): Promise<Hash> {
        return this.executeWrite("withdrawUsdc", [to, amount]);
    }

    async isAppSuspended(): Promise<boolean> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: APP_REGISTRY_ABI,
            functionName: "isAppSuspended",
            args: [this.appId],
        });
    }

    async appTerms(): Promise<Hex> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: APP_REGISTRY_ABI,
            functionName: "appTerms",
            args: [this.appId],
        });
    }

    async appTermsUri(): Promise<string> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: APP_REGISTRY_ABI,
            functionName: "appTermsUri",
            args: [this.appId],
        });
    }

    /** The agent card URI of this app, or of `appId`. Empty if none is set. */
    async appAgentUri(appId: Hex = this.appId): Promise<string> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: APP_REGISTRY_ABI,
            functionName: "appAgentUri",
            args: [appId],
        });
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
        // Oldest first; an app can only invite a wallet once (`AlreadyRegistered`).
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

    async appFee(): Promise<bigint> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: APP_REGISTRY_ABI,
            functionName: "appFee",
            args: [this.appId],
        });
    }

    async acceptedTerms(publisher: Address): Promise<Hex> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: APP_REGISTRY_ABI,
            functionName: "acceptedTerms",
            args: [this.appId, publisher],
        });
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
    private async joinTerms(publisher: Address): Promise<{ termsHash: Hex; fee: bigint }> {
        const [termsHash, , fee, status] = await this.readJoinInfoTuple(publisher);
        if (termsHash === ZERO_HASH) {
            throw new Error(
                `app ${this.appId} has published no terms — it cannot be joined until its owner sets them`,
            );
        }
        if ((status as PublisherStatus) === PublisherStatus.UNREGISTERED) {
            throw new Error(
                `${publisher} has not been added to app ${this.appId} — its owner must add them (addPublisher) before they can join`,
            );
        }
        return { termsHash, fee };
    }

    private async readJoinInfoTuple(
        publisher: Address,
        appId: Hex = this.appId,
    ): Promise<readonly [Hex, string, bigint, number, boolean]> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: APP_REGISTRY_ABI,
            functionName: "joinInfo",
            args: [appId, publisher],
        });
    }

    private senderAddress(): Address {
        const account = this.walletClient.account;
        if (!account) throw new Error("Account required");
        return account.address;
    }
}

const ZERO_HASH: Hex = `0x${"0".repeat(64)}`;
