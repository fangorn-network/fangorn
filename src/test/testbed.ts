import { createPublicClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Fangorn } from "../fangorn.js";
import { FangornConfig } from "../config.js";

// The testbed's app terms. Any non-zero value works — zero would leave the app
// unjoinable and every commit in the suite would revert NotRegisteredForApp.
const TESTBED_APP_TERMS =
    "0x0000000000000000000000000000000000000000000000000000000000000002" as const;

/**
 * The app the suite publishes under: one per test wallet, claimed by that wallet
 * on its first run and reused after. Not the SDK's default app — that one has an
 * owner, and joining it takes an invitation this wallet cannot give itself.
 */
export function suiteApp(sk: Hex | undefined): string {
    if (!sk) throw new Error("TestBed needs a private key: is ETH_PRIVATE_KEY set?");
    return `e2e-${privateKeyToAccount(sk).address.toLowerCase()}`;
}

const rpc = () => createPublicClient({ transport: http(FangornConfig.rpcUrl) });

export class TestBed {
    private constructor(private readonly f_list: Fangorn[]) {}

    /**
     * @param sks     one wallet per publisher in the forest; the first owns the app
     * @param appName the app namespace to publish under; defaults to the first
     *                wallet's own (`suiteApp`). Pass an unclaimed name to exercise
     *                the AppNotFound path.
     */
    static init(sks: Hex[], appName: string = suiteApp(sks[0])): TestBed {
        // populate fangorn forest
        const f_list: Fangorn[] = [];
        sks.forEach((sk) => {
            f_list.push(
                Fangorn.create({
                    privateKey: sk,
                    config: FangornConfig,
                    appId: appName,
                    storage: {
                        pinata: {
                            jwt: process.env.PINATA_JWT ?? "",
                            gateway: process.env.PINATA_GATEWAY ?? "",
                        },
                    },
                }),
            );
        });

        return new TestBed(f_list);
    }

    getFangorn(index: number): Fangorn {
        if (index > this.f_list.length) throw new Error("index out of bounds");
        const fangorn = this.f_list[index];
        return fangorn;
    }

    /**
     * Claim the configured app namespace, if nobody has yet.
     *
     * An app claims a unique namespace prefix that publishers may write under,
     * while a publisher registers for the right to write at all. One app hosts
     * many publishers, and one publisher writes into many apps — but only a
     * registered publisher can claim an app or be added to one, so this runs
     * `register` first. Idempotent: the app is shared by every test and every
     * run of this wallet, not claimed per test.
     */
    async registerApp(index: number) {
        // Global standing first: the AppRegistry refuses a claim from a wallet the
        // DataRegistry does not know.
        await this.register(index);
        const registry = this.getFangorn(index).getAppRegistry();
        const owner = await registry.getAppOwner();
        if (owner === "0x0000000000000000000000000000000000000000") {
            console.log(`Registering app ${registry.getAppId()} on-chain...`);
            // Real terms, because an app with a zero hash cannot be joined and
            // every commit in the suite would then revert NotRegisteredForApp.
            await registry.registerApp(TESTBED_APP_TERMS, "https://example.test/terms", 0n);
        }
        // Joining is a precondition for committing under the app, and it is by
        // invitation: for an app someone else owns, they must have added this
        // wallet first (`addPublisher`) or the join below throws saying so.
        const self = this.getFangorn(index).getAddress();
        if (!(await registry.isRegisteredForApp(self))) {
            console.log(`Joining app ${registry.getAppId()} as ${self}...`);
            await registry.registerForApp();
        }
    }

    // register as a publisher
    async register(index: number) {
        const fangorn = this.getFangorn(index);
        const accountAddress = fangorn.getAddress();

        const registry = fangorn.getDataRegistry();
        const isRegistered = await registry.isRegistered(accountAddress);
        if (!isRegistered) {
            console.log("Registering publisher on-chain...");
            await registry.register();
        }
    }

    /** The owner's half of a join: `owner` adds `publisher` to the app. */
    async invite(owner: number, publisher: number) {
        await this.getFangorn(owner)
            .getAppRegistry()
            .addPublisher(this.getFangorn(publisher).getAddress());
    }

    /** Gas money for a wallet the test generated, sent from a funded one. */
    async fund(from: number, to: number, wei: bigint) {
        const wallet = this.getFangorn(from).getWalletClient();
        if (!wallet.account) throw new Error("Account required");
        const hash = await wallet.sendTransaction({
            account: wallet.account,
            chain: wallet.chain,
            to: this.getFangorn(to).getAddress(),
            value: wei,
        });
        await rpc().waitForTransactionReceipt({ hash });
    }

    /**
     * Send what `from` still holds back to `to`: the other end of `fund`.
     *
     * The transfer has to leave room for its own gas, at the limit and price it
     * is sent with, so whatever of that goes unused stays behind. That is dust,
     * a small fraction of one transfer's fee.
     */
    async sweep(from: number, to: number) {
        const wallet = this.getFangorn(from).getWalletClient();
        if (!wallet.account) throw new Error("Account required");
        const { account } = wallet;
        const recipient = this.getFangorn(to).getAddress();
        const client = rpc();

        const [balance, fees, estimate] = await Promise.all([
            client.getBalance({ address: account.address }),
            client.estimateFeesPerGas(),
            client.estimateGas({ account, to: recipient, value: 1n }),
        ]);
        // The same 30% headroom as `sendWrite`: Arbitrum's estimate includes an
        // L1 component that can move before the transfer lands.
        const gas = (estimate * 130n) / 100n;
        const value = balance - gas * fees.maxFeePerGas;
        if (value <= 0n) return;

        const hash = await wallet.sendTransaction({
            account,
            chain: wallet.chain,
            to: recipient,
            value,
            gas,
            maxFeePerGas: fees.maxFeePerGas,
            maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        });
        await client.waitForTransactionReceipt({ hash });
    }

    async initRepo(index: number, name: string) {
        const fangorn = this.getFangorn(index);
        const res = await fangorn.initRepo(name);
        // cid, root, txhash
        return res;
    }

    //
    async upload(
        /// the f_list index
        index: number,
        // the repo/namespace
        namespace: string,
        // the payload itself
        payload: unknown,
        // name of the payload
        name: string,
    ) {
        const fangorn = this.getFangorn(index);
        const res = await fangorn.upload(namespace, payload, name);
        // cid, root, txhash, newHead
        return res;
    }

    async uploadBatch(
        index: number,
        namespace: string,
        vertices: { id: string; tag: string; payload: unknown }[],
        edges: { rel: string; from: string; to: string }[] = [],
    ) {
        const fangorn = this.getFangorn(index);
        return fangorn.uploadBatch(namespace, vertices, edges);
    }

    async fetch(index: number, cid: string, namespace: string) {
        // Vertex blocks live inside commit CAR files (not individual pins), so
        // resolve through the publisher's commit chain rather than the gateway.
        const fangorn = this.getFangorn(index);
        return fangorn.engine.readVertex(cid, fangorn.getAddress(), namespace);
    }

    /** Owner of the configured app namespace, or the zero address if unclaimed. */
    async appOwner(index: number) {
        return this.getFangorn(index).getAppRegistry().getAppOwner();
    }

    /** The raw on-chain head of one namespace — the slot the CAS actually guards. */
    async head(index: number, namespace: string) {
        const fangorn = this.getFangorn(index);
        return fangorn
            .getDataRegistry()
            .getNamespaceHead(fangorn.getAddress(), namespace);
    }

    async inspect(index: number, namespace: string) {
        const fangorn = this.getFangorn(index);
        return fangorn.inspectNamespace(namespace);
    }
}