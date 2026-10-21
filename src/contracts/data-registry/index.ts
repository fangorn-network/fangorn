import { keccak256, toHex, type Hex } from "viem";

/** A repo's on-chain id: keccak256 of its name's UTF-8 bytes, never of the name as hex. */
export function repoId(repo: string): Hex {
    return keccak256(toHex(repo));
}
