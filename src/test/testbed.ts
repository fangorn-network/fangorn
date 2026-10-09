import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createTestClient, http, parseEther, publicActions, walletActions, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Fangorn } from "../fangorn.js";
import { PinataSDK } from "pinata";
import { type AppConfig, FangornConfig } from "../config.js";

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
    if (!sk) throw new Error("TestBed needs a private key");
    return `e2e-${privateKeyToAccount(sk).address.toLowerCase()}`;
}

const hasAnvil = spawnSync("anvil", ["--version"]).status === 0;

/**
 * Without anvil a suite that runs on a fork shows as skipped, except in CI,
 * where it has to fail rather than quietly stop testing.
 */
export const skipFork = !hasAnvil && !process.env.CI;

// What this test file started and has to put away again: see `cleanUp`.
const forks: ChildProcess[] = [];
// Pinata's id for every file this test file uploads. A delete takes that id,
// and the SDK's storage backend hands back CIDs, never ids. So it is read here,
// from Pinata's own answer to each upload, and the SDK is left without any
// code that exists only for the tests.
const uploaded: string[] = [];

const PINATA_UPLOADS = "https://uploads.pinata.cloud/v3/files";
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
    const response = await realFetch(input, init);
    const url = input instanceof Request ? input.url : input.toString();
    if (init?.method === "POST" && url.startsWith(PINATA_UPLOADS) && response.ok) {
        const { data } = (await response.clone().json()) as {
            data?: { id?: string; is_duplicate?: boolean };
        };
        // A duplicate is a file the account had pinned before this upload: not
        // ours to remove.
        if (data?.id && !data.is_duplicate) uploaded.push(data.id);
    }
    return response;
};

/**
 * Fork the deployed chain locally (anvil, on a port it picks).
 *
 * Every suite that writes runs on one. The contracts and their state are the
 * deployed ones, so the tests exercise the real code, but what they claim,
 * register and commit is gone when the fork stops. On the real chain it could
 * never be removed, and every run would add to the registries.
 */
export async function startFork() {
    if (!hasAnvil) {
        throw new Error("anvil is not installed: in CI the fork suites fail rather than skip");
    }
    const anvil = spawn("anvil", ["--fork-url", FangornConfig.rpcUrl, "--port", "0"], {
        stdio: ["ignore", "pipe", "inherit"],
    });
    forks.push(anvil);
    const rpcUrl = await new Promise<string>((resolve, reject) => {
        let output = "";
        anvil.stdout.on("data", (chunk: Buffer) => {
            output += chunk.toString();
            const listening = /Listening on (\S+)/.exec(output);
            if (listening) resolve(`http://${listening[1]}`);
        });
        anvil.once("error", reject);
        anvil.once("exit", (code) => {
            reject(new Error(`anvil exited (${String(code)}) before it was listening`));
        });
    });
    const config: AppConfig = { ...FangornConfig, rpcUrl };
    const chain = createTestClient({
        mode: "anvil",
        chain: config.chain,
        transport: http(rpcUrl),
    })
        .extend(publicActions)
        .extend(walletActions);

    return {
        /** The SDK's deployment, reached through the fork. */
        config,
        /** The fork itself: set balances, impersonate accounts, read blocks. */
        chain,
        /** A new wallet with gas. Nothing on a fork costs anything. */
        wallet: async (): Promise<Hex> => {
            const sk = generatePrivateKey();
            await chain.setBalance({
                address: privateKeyToAccount(sk).address,
                value: parseEther("1"),
            });
            return sk;
        },
        /** A test bed on the fork: `TestBed.init` with the fork's config. */
        bed: (sks: Hex[], appName?: string) => TestBed.init(sks, appName, config),
    };
}

export type Fork = Awaited<ReturnType<typeof startFork>>;

/**
 * Put away what this test file left behind: stop its forks, and unpin every
 * file it uploaded to Pinata. Call it from `afterAll`.
 */
export async function cleanUp(): Promise<void> {
    for (const anvil of forks.splice(0)) anvil.kill();
    const ids = uploaded.splice(0);
    if (ids.length === 0) return;
    const pinata = new PinataSDK({ pinataJwt: process.env.PINATA_JWT ?? "" });
    // The SDK reports a failed delete as a status string rather than throwing.
    const failed = (await pinata.files.public.delete(ids)).filter((r) => /error|failed/i.test(r.status));
    if (failed.length > 0) {
        throw new Error(
            `Pinata did not unpin ${String(failed.length)} of ${String(ids.length)} files: ${failed[0].status}`,
        );
    }
    console.log(`Unpinned ${String(ids.length)} files from Pinata`);
}

export class TestBed {
    private constructor(private readonly f_list: Fangorn[]) {}

    /**
     * @param sks     one wallet per publisher in the forest; the first owns the app
     * @param appName the app namespace to publish under; defaults to the first
     *                wallet's own (`suiteApp`). Pass an unclaimed name to exercise
     *                the AppNotFound path.
     * @param config  the deployment to talk to; defaults to the SDK's. Pass one
     *                with another `rpcUrl` to run against a local fork.
     */
    static init(
        sks: Hex[],
        appName: string = suiteApp(sks[0]),
        config: AppConfig = FangornConfig,
    ): TestBed {
        // populate fangorn forest
        const f_list: Fangorn[] = [];
        sks.forEach((sk) => {
            f_list.push(
                Fangorn.create({
                    privateKey: sk,
                    config,
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