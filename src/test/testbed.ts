import { type Hex } from "viem";
import { Fangorn } from "../fangorn.js";

export class TestBed {
    private constructor(private readonly f_list: Fangorn[]) {}

    static init(sks: Hex[]): TestBed {
        // populate fangorn forest
        const f_list: Fangorn[] = [];
        sks.forEach((sk) => {
            f_list.push(
                Fangorn.create({
                    privateKey: sk,
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

    // set the state root to zero
    async resetContractState(index: number) {
        const fangorn = this.getFangorn(index);
        const registry = fangorn.getDataRegistry();
        const currentRoot = await registry.getNamespaceHead(fangorn.getAddress());
        const ZERO_BYTES32: Hex =
            "0x0000000000000000000000000000000000000000000000000000000000000000";
        await fangorn.getDataRegistry().commitStateRoot(currentRoot, ZERO_BYTES32);
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

    async fetch(index: number, cid: string) {
        // Vertex blocks live inside commit CAR files (not individual pins), so
        // resolve through the publisher's commit chain rather than the gateway.
        const fangorn = this.getFangorn(index);
        return fangorn.engine.readVertex(cid, fangorn.getAddress());
    }

    async inspect(index: number, namespace: string) {
        const fangorn = this.getFangorn(index);
        return fangorn.inspectNamespace(namespace);
    }
}