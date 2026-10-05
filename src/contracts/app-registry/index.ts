import {
    ContractFunctionArgs,
    ContractFunctionName,
    encodeFunctionData,
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

/** One `AppAgentChanged` event: an app owner pointed their app at a card. */
export interface AppAgentLog {
    appId: Hex;
    agentUri: string;
    blockNumber: bigint;
    transactionHash: Hash;
}

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
     */
    async registerApp(termsHash: Hex, termsUri: string, fee = 0n): Promise<Hash> {
        return this.executeWrite("registerApp", [this.appId, termsHash, termsUri, fee]);
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
     * Registration = accepting its current terms
     */
    async registerForApp(): Promise<Hash> {
        const [termsHash, , fee] = await this.readJoinInfoTuple(this.senderAddress());
        if (termsHash === ZERO_HASH) {
            throw new Error(
                `app ${this.appId} has published no terms — it cannot be joined until its owner sets them`,
            );
        }
        return this.executeWrite("registerForApp", [this.appId, termsHash], fee);
    }

    /**
     * prepare the tx to register as a publisher for an app
     */
    async prepareRegisterForApp(publisher: Address): Promise<PreparedTx & { value: Hex }> {
        const [termsHash, , fee] = await this.readJoinInfoTuple(publisher);
        if (termsHash === ZERO_HASH) {
            throw new Error(
                `app ${this.appId} has published no terms — it cannot be joined until its owner sets them`,
            );
        }

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
                    `joining would revert — this wallet may already be registered, or suspended from this app: ${message}`,
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

    async getAppOwner(): Promise<Address> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: APP_REGISTRY_ABI,
            functionName: "getAppOwner",
            args: [this.appId],
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

    private async readJoinInfoTuple(
        publisher: Address,
    ): Promise<readonly [Hex, string, bigint, number, boolean]> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: APP_REGISTRY_ABI,
            functionName: "joinInfo",
            args: [this.appId, publisher],
        });
    }

    private senderAddress(): Address {
        const account = this.walletClient.account;
        if (!account) throw new Error("Account required");
        return account.address;
    }
}

const ZERO_HASH: Hex = `0x${"0".repeat(64)}`;
