import { encodeFunctionData, keccak256, toHex, type Abi, type Address, type Hex, type PublicClient } from "viem";

/** A repo's on-chain id: keccak256 of its name's UTF-8 bytes, never of the name as hex. */
export function repoId(repo: string): Hex {
    return keccak256(toHex(repo));
}

/**
 * An unsigned transaction, hex-encoded and ready to hand to a browser wallet's
 * `eth_sendTransaction` — no `from`, since the signing wallet supplies it.
 */
export interface PreparedTx {
    to: Address;
    data: Hex;
    chainId: number | undefined;
    gas: Hex;
    maxFeePerGas: Hex;
    maxPriorityFeePerGas: Hex;
}

/**
 * Build a contract call as an UNSIGNED transaction for `from` to sign — the
 * self-custodial path: a relay server builds it with a keyless service wallet and
 * the user's browser wallet signs, so the on-chain sender is the user.
 *
 * Fees and gas are quoted here rather than left to the wallet: wallet estimation
 * runs too tight against a live L2 base fee, and an eth_estimateGas from the
 * wallet against a public RPC is what surfaces as "Network fee Unavailable" in
 * MetaMask. maxFeePerGas is only a ceiling, so headroom costs nothing. Simulating
 * here also turns a would-be revert into a clear error now, instead of a cryptic
 * wallet message after the user has clicked sign.
 */
export async function prepareTx(
    publicClient: PublicClient,
    from: Address,
    to: Address,
    abi: Abi,
    functionName: string,
    args: readonly unknown[],
): Promise<PreparedTx> {
    const data = encodeFunctionData({ abi, functionName, args });
    const fees = await publicClient.estimateFeesPerGas();
    let gas: bigint;
    try {
        gas = ((await publicClient.estimateGas({ account: from, to, data })) * 3n) / 2n;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/revert/i.test(message)) throw new Error(`${functionName} would revert: ${message}`);
        gas = 5_000_000n; // RPC hiccup, not a revert — proceed with a safe ceiling
    }
    return {
        to,
        data,
        chainId: publicClient.chain?.id,
        gas: toHex(gas),
        maxFeePerGas: toHex(fees.maxFeePerGas * 2n),
        maxPriorityFeePerGas: toHex(fees.maxPriorityFeePerGas),
    };
}
