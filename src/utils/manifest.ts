import { type Address, type Hex, keccak256, encodePacked } from "viem";
import { poseidon2 } from "poseidon-lite";

// Pure client-side manifest/id utilities. These used to live inside the
// datasource-registry wrapper but are not contract-specific — they compute the
// merkle commitment and the datasource resourceId off-chain, independent of any
// registry. Publisher/consumer/tests share them from here.

const MODULUS =
    21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function normalize(v: bigint): bigint {
    return ((v % MODULUS) + MODULUS) % MODULUS;
}

export function poseidonHash(inputs: bigint[]): bigint {
    return poseidon2(inputs.map(normalize));
}

function bytesToField(chunk: Uint8Array): bigint {
    let acc = 0n;
    for (const b of chunk) acc = (acc << 8n) | BigInt(b);
    return acc;
}

export function hashString(value: string): bigint {
    const bytes = new TextEncoder().encode(value);
    let h = 0n;                       // IV; "" => 0n
    for (let i = 0; i < bytes.length; i += 31) {
        h = poseidonHash([h, bytesToField(bytes.subarray(i, i + 31))]);
    }
    return h;
}

export interface ManifestLeaf {
    index: bigint;
    name: string;
}

/* eslint-disable @typescript-eslint/no-extraneous-class */
export class MerkleTree {
    protected constructor() {
        throw new Error("MerkleTree is a static utility class and cannot be instantiated.");
    }

    static leafHash(leaf: ManifestLeaf): bigint {
        return poseidonHash([
            leaf.index,
            hashString(leaf.name),
        ]);
    }

    static buildTree(leaves: ManifestLeaf[]) {
        if (leaves.length === 0) throw new Error("Empty tree");

        const sorted = [...leaves].sort((a, b) => Number(a.index - b.index));

        let current = sorted.map(leaf => MerkleTree.leafHash(leaf));
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

        return { root: current[0], layers };
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
        return `0x${root.toString(16).padStart(64, "0")}`;
    }
}

/** Off-chain datasource resourceId: keccak(owner ‖ schemaId ‖ keccak(name)). */
export function resourceId(owner: Address, schemaId: Hex, name: string): Hex {
    const nameHash = keccak256(new TextEncoder().encode(name));
    return keccak256(
        encodePacked(["address", "bytes32", "bytes32"], [owner, schemaId, nameHash]),
    );
}
