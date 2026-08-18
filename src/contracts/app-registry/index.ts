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
 * Client for the AppRegistry — app ids, per-app publisher terms, per-app join
 * fees, and per-app membership.
 *
 * This contract owns what an "app" is. `registerApp` and `getAppOwner` used to
 * live on the DataRegistry, which meant two contracts held partial opinions about
 * apps and neither could enforce membership. The dependency now runs one way:
 * `DataRegistry.commitStateRoot` cross-calls `isRegisteredForApp` here, so a
 * publisher must join an app *before* they can write under it.
 *
 * Scoped to one `appId`, like `DataRegistryClient` — the app is an identity the
 * client carries, not an argument every call repeats.
 */
export class AppRegistryClient {
    constructor(
        private contractAddress: Address,
        private appId: Hex,
        private publicClient: PublicClient,
        private walletClient: WalletClient,
    ) { }

    /** The app every call on this client is scoped to. */
    getAppId(): Hex {
        return this.appId;
    }

    /** Re-scope every subsequent call to a different app. */
    setAppId(appId: Hex): void {
        this.appId = appId;
    }

    /** The deployed AppRegistry this client talks to. */
    getAddress(): Address {
        return this.contractAddress;
    }


    /** Same gas buffer and fee styling as DataRegistryClient.executeWrite. */
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

    // ── App owner ────────────────────────────────────────────────────────────

    /**
     * Claim this client's `appId` and open it in one transaction — owner, terms
     * and join fee together. First come, first served, and irreversible: there is
     * no transfer and no release.
     *
     * `termsHash` must be real. An app whose terms hash is zero cannot be joined
     * by anyone, so claiming an id without them creates a market nobody can enter.
     */
    async registerApp(termsHash: Hex, termsUri: string, fee = 0n): Promise<Hash> {
        return this.executeWrite("registerApp", [this.appId, termsHash, termsUri, fee]);
    }

    /**
     * Publish new terms for this app.
     *
     * This drops every publisher back to "must accept again" — `isRegisteredForApp`
     * is false for anyone whose accepted hash no longer matches — so it is a real
     * act with a real consequence, not a copy edit. Re-accepting is free for them.
     */
    async setAppTerms(termsHash: Hex, termsUri: string): Promise<Hash> {
        return this.executeWrite("setAppTerms", [this.appId, termsHash, termsUri]);
    }

    /** Set what joining this app costs, in wei. Paid to the app owner. */
    async setAppFee(fee: bigint): Promise<Hash> {
        return this.executeWrite("setAppFee", [this.appId, fee]);
    }

    /**
     * Eject a publisher from THIS app. Their global DataRegistry standing and
     * their membership of every other app are untouched.
     */
    async suspendForApp(publisher: Address): Promise<Hash> {
        return this.executeWrite("suspendForApp", [this.appId, publisher]);
    }

    async reinstateForApp(publisher: Address): Promise<Hash> {
        return this.executeWrite("reinstateForApp", [this.appId, publisher]);
    }

    // ── Publishers ───────────────────────────────────────────────────────────

    /**
     * Join this app, accepting its current terms by the act of doing so.
     *
     * The hash is read immediately before sending and passed as an argument, and
     * the contract reverts `TermsMismatch` if it no longer matches. That is the
     * point: the transaction is only valid against the exact version that was in
     * front of the caller, so terms cannot change under a pending registration and
     * land as agreement to something else. A race here is a revert, not a
     * surprise obligation.
     *
     * The join fee is read from the chain rather than passed in, for the same
     * reason `DataRegistryClient.register()` reads the registration fee: a caller
     * who supplies it can supply the wrong one.
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
     * The same join, as an unsigned transaction for a wallet that signs elsewhere
     * (the sond3r relay never holds a key). Mirrors `prepareCommitStateRoot`.
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
            gas = 1_000_000n; // RPC hiccup, not a revert
        }

        return {
            to: this.contractAddress,
            data,
            chainId: this.publicClient.chain?.id,
            gas: toHex(gas),
            maxFeePerGas: toHex(fees.maxFeePerGas * 2n),
            maxPriorityFeePerGas: toHex(fees.maxPriorityFeePerGas),
            // The join fee rides as tx value. Omitting it is a `JoinFeeRequired`
            // revert after the user has already clicked sign.
            value: toHex(fee),
        };
    }

    // ── Views ────────────────────────────────────────────────────────────────

    /** Owner of this client's app id, or the zero address if unclaimed. */
    async getAppOwner(): Promise<Address> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: APP_REGISTRY_ABI,
            functionName: "getAppOwner",
            args: [this.appId],
        });
    }

    /**
     * May this publisher commit under this app? This is the exact question
     * `DataRegistry.commitStateRoot` asks on-chain, so a false here means a
     * publish would revert.
     */
    async isRegisteredForApp(publisher: Address): Promise<boolean> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: APP_REGISTRY_ABI,
            functionName: "isRegisteredForApp",
            args: [this.appId, publisher],
        });
    }

    /** This app's current terms hash, or the zero hash if it has published none. */
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

    async appFee(): Promise<bigint> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: APP_REGISTRY_ABI,
            functionName: "appFee",
            args: [this.appId],
        });
    }

    /** The terms hash this publisher accepted, or the zero hash. */
    async acceptedTerms(publisher: Address): Promise<Hex> {
        return this.publicClient.readContract({
            address: this.contractAddress,
            abi: APP_REGISTRY_ABI,
            functionName: "acceptedTerms",
            args: [this.appId, publisher],
        });
    }

    /**
     * Everything a join screen needs. Two reads rather than one, because the
     * accepted hash is what turns "not registered" into the far more useful "the
     * terms changed since you joined".
     */
    async joinInfo(publisher: Address): Promise<AppJoinInfo> {
        const [tuple, acceptedTerms] = await Promise.all([
            this.readJoinInfoTuple(publisher),
            this.acceptedTerms(publisher),
        ]);
        const [termsHash, termsUri, fee, status, registered] = tuple;
        return {
            termsHash,
            termsUri,
            fee,
            status: status as PublisherStatus,
            registered,
            acceptedTerms,
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
