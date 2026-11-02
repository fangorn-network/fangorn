import {
    ContractFunctionArgs,
    ContractFunctionName,
    ContractFunctionReturnType,
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

export type { PreparedTx } from "../write.js";

type ViewName = ContractFunctionName<typeof APP_REGISTRY_ABI, "view" | "pure">;
type WriteName = ContractFunctionName<typeof APP_REGISTRY_ABI, "payable" | "nonpayable">;

/** One `AppAgentChanged` event: an app owner pointed their app at a card. */
export interface AppAgentLog {
    appId: Hex;
    agentUri: string;
    blockNumber: bigint;
    transactionHash: Hash;
}

/**
 * Client for the AppRegistry: an app's id, owner, repo of citations, payout
 * address and agent card.
 *
 * An app can be renamed (`renameApp`): the new id is an alias of the id it was
 * registered under. The contract accepts any id an app has gone by.
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

    // ── Apps ─────────────────────────────────────────────────────────────────

    /** Register this app, owned by the caller. Free. */
    async registerApp(): Promise<Hash> {
        return this.executeWrite("registerApp", [this.app()]);
    }

    async getAppOwner(appId: Hex = this.app()): Promise<Address> {
        return this.read("getAppOwner", [appId]);
    }

    /** Point this app at its repo of citations, `(curator, repo)` (owner only). */
    async setCurator(curator: Address, repo: string): Promise<Hash> {
        return this.executeWrite("setCurator", [this.app(), curator, repo]);
    }

    /** The app's repo of citations. The curator is the owner unless set. */
    async curatorOf(appId: Hex = this.app()): Promise<{ curator: Address; repo: string }> {
        const [curator, repo] = await this.read("curatorOf", [appId]);
        return { curator, repo };
    }

    /** Where the app's referral share is paid (owner only). Zero pays the owner. */
    async setPayout(payout: Address): Promise<Hash> {
        return this.executeWrite("setPayout", [this.app(), payout]);
    }

    /** Where the app's referral share is paid: the payout address, or the owner. */
    async payoutOf(appId: Hex = this.app()): Promise<Address> {
        return this.read("payoutOf", [appId]);
    }

    // ── Renaming ─────────────────────────────────────────────────────────────

    /**
     * Give this app a new id (owner only). `newId` becomes an alias of the
     * canonical id, and every id it went by still resolves to it. `newId` must be unclaimed, or an id this app already goes by (renaming
     * back); one held by another app reverts `AppAlreadyRegistered`.
     *
     * This client stays scoped to the id it had, which still works; switch it
     * with `setAppId(newId)`.
     */
    async renameApp(newId: Hex): Promise<Hash> {
        return this.executeWrite("renameApp", [this.app(), newId]);
    }

    /** The id this app (or `appId`) was registered under. An id no app goes by comes back unchanged. */
    async canonicalAppId(appId: Hex = this.app()): Promise<Hex> {
        return this.read("canonicalAppId", [appId]);
    }

    /**
     * The id this app (or `appId`) goes by now: the last it was renamed to, or its
     * canonical id. An id no app goes by comes back unchanged.
     */
    async currentAppId(appId: Hex = this.app()): Promise<Hex> {
        return this.read("currentAppId", [appId]);
    }

    // ── Listing apps ─────────────────────────────────────────────────────────
    // Every registered app id, oldest first, suspended apps included.

    /** How many apps have been registered. A rename adds none. */
    async appCount(): Promise<bigint> {
        return this.read("appCount", []);
    }

    /** Up to `limit` canonical app ids from position `offset`, oldest first; fewer past the end. */
    async appsPage(offset: bigint, limit: bigint): Promise<readonly Hex[]> {
        return this.read("appsPage", [offset, limit]);
    }

    /**
     * Every registered app id (canonical; see `currentAppId`), oldest first.
     * ponytail: one eth_call for all of them; page with `appsPage` once the list
     * outgrows the RPC's eth_call gas cap (tens of thousands of apps).
     */
    async allApps(): Promise<readonly Hex[]> {
        return this.appsPage(0n, await this.appCount());
    }

    /** The app ids `owner` registered (canonical; see `currentAppId`), oldest first. */
    async appsOf(owner: Address): Promise<readonly Hex[]> {
        return this.read("appsOf", [owner]);
    }

    /** Point this app at its ERC-8004 agent card (owner only). */
    async setAppAgentUri(agentUri: string): Promise<Hash> {
        return this.executeWrite("setAppAgentUri", [this.app(), agentUri]);
    }

    async isAppSuspended(): Promise<boolean> {
        return this.read("isAppSuspended", [this.app()]);
    }

    /** The agent card URI of this app, or of `appId`. Empty if none is set. */
    async appAgentUri(appId: Hex = this.app()): Promise<string> {
        return this.read("appAgentUri", [appId]);
    }

    // ── Logs ─────────────────────────────────────────────────────────────────

    /**
     * `AppAgentChanged` events, oldest first. The last one for an app is its
     * current card; an empty `agentUri` means the owner unset it.
     *
     * Events carry the canonical id: `appId` may be any id the app goes by, and
     * each log's `appId` is the canonical one.
     *
     * Leave `appId` out to list every app that has ever set a card. To list apps,
     * use `allApps` or `appsOf`, which are one read each; this is a windowed log
     * scan, for a card's history. `fromBlock` is required because scanning from genesis on an L2 costs
     * hundreds of thousands of RPC calls. Pass the AppRegistry's deploy block, or
     * a block you know to be before the app's registration.
     */
    async getAppAgentLogs(opts: {
        appId?: Hex;
        fromBlock: bigint;
        toBlock?: bigint;
    }): Promise<AppAgentLog[]> {
        const appId = opts.appId && (await this.canonicalAppId(opts.appId));
        const logs = await getLogsInWindows(this.publicClient, opts.fromBlock, opts.toBlock, (from, to) =>
            this.publicClient.getContractEvents({
                address: this.contractAddress,
                abi: APP_REGISTRY_ABI,
                eventName: "AppAgentChanged",
                args: appId ? { app_id: appId } : {},
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

    /** Take this app's name down, or restore it. */
    async setAppSuspended(suspended: boolean): Promise<Hash> {
        return this.executeWrite("setAppSuspended", [this.app(), suspended]);
    }

    async setDataRegistry(registry: Address): Promise<Hash> {
        return this.executeWrite("setDataRegistry", [registry]);
    }

    /** Send `amount` of an ERC-20 the contract holds to `to`. */
    async withdrawToken(token: Address, to: Address, amount: bigint): Promise<Hash> {
        return this.executeWrite("withdrawToken", [token, to, amount]);
    }
}

