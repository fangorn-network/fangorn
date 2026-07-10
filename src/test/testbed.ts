import {
    type Address,
    type Chain,
    type Hex,
    type WalletClient,
} from "viem";
import { arbitrumSepolia, baseSepolia } from "viem/chains";
import { Fangorn } from "../fangorn.js";
import { type AppConfig, FangornConfig } from "../config.js";
import { StringDecoder } from "node:string_decoder";

export class TestBed {
    private constructor(
        private readonly f_list: Fangorn[],
    ) { }

    static init(
        sks: Hex[],
    ): TestBed {
        // populate fangorn forest
        let f_list: Fangorn[] = [];
        sks.forEach(sk => {
            f_list.push(Fangorn.create({
                privateKey: sk,
                storage: {
                    pinata: {
                        jwt: process.env.PINATA_JWT ?? "",
                        gateway: process.env.PINATA_GATEWAY ?? "",
                    },
                },
            }));
        })

        return new TestBed(f_list)
    }

    getFangorn(index: number): Fangorn {
        if (index > this.f_list.length) throw new Error("index out of bounds")
        const fangorn = this.f_list[index];
        return fangorn;
    }

    // register as a publisher
    async register(
        index: number
    ) {
        const fangorn = this.getFangorn(index)
        const accountAddress = fangorn.getAddress();

        const registry = fangorn.getDataRegistry();
        const isRegistered = await registry.isRegistered(accountAddress);
        if (!isRegistered) {
            console.log("Registering publisher on-chain...");
            await registry.register();
        }
    }

    async initRepo(index: number, name: string) {
        const fangorn = this.getFangorn(index)
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
        // the payload itseld
        payload: any,
        // name of the payload
        name: string,
    ) {
        throw new Error("fail")
        // const fangorn = this.getFangorn(index);
        // const res = await fangorn.upload(namespace, payload, name);
        // // cid, root, txhash, newHead
        // return res;
    }

    async fetch(index: number, cid: string) {
        const fangorn = this.getFangorn(index);
        const retrieved = fangorn.getStorage().get<any>(cid);
        return retrieved;
    }

    // // "bundle" funcs
    // async registerBundle(name: string, bundle: BundleInput): Promise<Hex> {
    //     const { schemaId } = await this.delegatorFangorn.schema.register({
    //         kind: "bundle",
    //         name,
    //         bundle,
    //     });
    //     return schemaId;
    // }

    // async publishBundle(
    //     bundleName: string,
    //     nodes: { id: string; type: string; fields: Record<string, FieldInput> }[],
    //     edges: { rel: string; from: string; to: string }[],
    //     datasetName?: string,
    // ): Promise<string> {
    //     const { manifestUri } = await this.getDelegatorFangorn().publisher.publishBundle({
    //         bundleName,
    //         nodes,
    //         edges,
    //         datasetName,
    //     });
    //     return manifestUri;
    // }

    // getDelegatorAddress(): Address { return this.delegatorAddress; }
    // getDelegatorFangorn(): Fangorn { return this.delegatorFangorn; }
    // getDelegateeFangorn(): Fangorn { return this.delegateeFangorn; }
}
