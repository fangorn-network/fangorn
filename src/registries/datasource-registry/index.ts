import {
    type Address,
    type Hash,
    type Hex,
    type PublicClient,
    type WalletClient,
    keccak256,
    encodePacked,
} from "viem";

import { poseidon2 } from "poseidon-lite";
import { DS_REGISTRY_ABI } from "./abi.js";

const MODULUS =
    21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function normalize(v: bigint): bigint {
    return ((v % MODULUS) + MODULUS) % MODULUS;
}

function poseidonHash(inputs: bigint[]): bigint {
    return BigInt(poseidon2(inputs.map(normalize)));
}

function hashString(value: string): bigint {
    return normalize(BigInt(keccak256(new TextEncoder().encode(value))));
}

export interface ManifestLeaf {
    index: bigint;
    name: string;
}

export class MerkleTree {
    static leafHash(leaf: ManifestLeaf): bigint {
        return poseidonHash([
            leaf.index,
            hashString(leaf.name),
        ]);
    }

    static buildTree(leaves: ManifestLeaf[]) {
        if (leaves.length === 0) throw new Error("Empty tree");

        const sorted = [...leaves].sort((a, b) =>
            Number(a.index - b.index),
        );

        let current = sorted.map(MerkleTree.leafHash);
        const layers: bigint[][] = [current];

        while (current.length > 1) {
            const next: bigint[] = [];

            for (let i = 0; i < current.length; i += 2) {
                const left = current[i];
                const right = current[i + 1] ?? left;
                next.push(poseidonHash([left, right]));
            }

            current = next;
            layers.push(next);
        }

        return {
            root: current[0],
            layers,
        };
    }

    static buildProof(layers: bigint[][], index: number): bigint[] {
        const proof: bigint[] = [];

        for (let d = 0; d < layers.length - 1; d++) {
            const layer = layers[d];

            const sibling =
                index % 2 === 0
                    ? layer[index + 1] ?? layer[index]
                    : layer[index - 1];

            proof.push(sibling);
            index = Math.floor(index / 2);
        }

        return proof;
    }

    static rootToHex(root: bigint): Hex {
        return `0x${root.toString(16).padStart(64, "0")}` as Hex;
    }
}

export interface DataSource {
    manifestCid: string;
    merkleRoot: Hex;
    name: string;
    schemaId: Hex;
    version: bigint;
}

export class DataSourceRegistry {
    constructor(
        private contractAddress: Address,
        private publicClient: PublicClient,
        private walletClient: WalletClient,
    ) { }

    private getWriteConfig() {
        if (!this.walletClient.chain) throw new Error("Chain required");
        if (!this.walletClient.account) throw new Error("Account required");

        return {
            chain: this.walletClient.chain,
            account: this.walletClient.account,
        };
    }

    async publish(
        manifestCid: string,
        merkleRoot: Hex,
        schemaId: Hex,
        name: string,
    ): Promise<Hash> {
        const { chain, account } = this.getWriteConfig();

        const fees = await this.publicClient.estimateFeesPerGas();

        const gas = await this.publicClient.estimateContractGas({
            address: this.contractAddress,
            abi: DS_REGISTRY_ABI,
            functionName: "publish",
            args: [manifestCid, merkleRoot, schemaId, name],
            account,
        });

        const hash = await this.walletClient.writeContract({
            address: this.contractAddress,
            abi: DS_REGISTRY_ABI,
            functionName: "publish",
            args: [manifestCid, merkleRoot, schemaId, name],
            chain,
            account,
            gas: (gas * 130n) / 100n,
            maxFeePerGas: fees.maxFeePerGas * 3n,
            maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        });
        await this.publicClient.waitForTransactionReceipt({ hash });

        return hash;
    }

    async get(
        owner: Address,
        schemaId: Hex,
        name: string,
    ): Promise<DataSource> {
        const [tuple, version] = await Promise.all([
            this.publicClient.readContract({
                address: this.contractAddress,
                abi: DS_REGISTRY_ABI,
                functionName: "get",
                args: [owner, schemaId, name],
            }) as Promise<readonly [string, Hex]>,

            this.publicClient.readContract({
                address: this.contractAddress,
                abi: DS_REGISTRY_ABI,
                functionName: "getVersion",
                args: [owner, schemaId, name],
            }) as Promise<bigint>,
        ]);

        const [manifestCid, merkleRoot] = tuple;

        return {
            manifestCid,
            merkleRoot,
            name,
            schemaId,
            version,
        };
    }

    static resourceId(owner: Address, schemaId: Hex, name: string): Hex {
        const nameHash = keccak256(
            new TextEncoder().encode(name),
        );

        return keccak256(
            encodePacked(
                ["address", "bytes32", "bytes32"],
                [owner, schemaId, nameHash],
            ),
        );
    }

    static hashName(name: string): Hex {
        return keccak256(new TextEncoder().encode(name));
    }
}