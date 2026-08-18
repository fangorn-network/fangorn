import { type Hex } from "viem";
import { Fangorn } from "../fangorn.js";
import { FangornConfig } from "../config.js";

// The testbed's app terms. Any non-zero value works — zero would leave the app
// unjoinable and every commit in the suite would revert NotRegisteredForApp.
const TESTBED_APP_TERMS =
    "0x0000000000000000000000000000000000000000000000000000000000000002" as const;

export class TestBed {
    private constructor(private readonly f_list: Fangorn[]) {}

    /**
     * @param sks     one wallet per publisher in the forest
     * @param appName the app namespace to publish under; defaults to the SDK's
     *                own. Pass an unclaimed name to exercise the AppNotFound path.
     */
    static init(sks: Hex[], appName?: string): TestBed {
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
     * Orthogonal to `register`: an app claims a unique namespace prefix that
     * publishers may write under, while a publisher registers for the right to
     * write at all. Neither implies the other — one app hosts many publishers,
     * and one publisher writes into many apps. Idempotent, and safe when someone
     * else already owns it: apps are shared, not per-test.
     */
    async registerApp(index: number) {
        const registry = this.getFangorn(index).getAppRegistry();
        const owner = await registry.getAppOwner();
        if (owner === "0x0000000000000000000000000000000000000000") {
            console.log(`Registering app ${registry.getAppId()} on-chain...`);
            // Real terms, because an app with a zero hash cannot be joined and
            // every commit in the suite would then revert NotRegisteredForApp.
            await registry.registerApp(TESTBED_APP_TERMS, "https://example.test/terms", 0n);
        }
        // Joining is now a precondition for committing under the app.
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