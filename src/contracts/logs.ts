import type { PublicClient } from "viem";
import { nonBlank } from "../config.js";

/**
 * Run `fetch` over [fromBlock, toBlock] in consecutive block windows and
 * concatenate the results, oldest window first.
 *
 * RPC providers limit how many blocks one `eth_getLogs` call can cover. The
 * public Arbitrum Sepolia endpoint rejects anything past a couple of thousand
 * blocks with a bare "internal server errror". So a single wide-range call fails
 * outright, and whatever depends on it (a catch-up, a directory listing) fails
 * with it. Tune the window with `FANGORN_LOG_WINDOW`; a private RPC will take far
 * more.
 *
 * `defaultWindow` is for a query the endpoint is known to serve over a wider
 * range. `FANGORN_LOG_WINDOW` still overrides it.
 */
export async function getLogsInWindows<T>(
    publicClient: PublicClient,
    fromBlock: bigint,
    toBlock: bigint | undefined,
    fetch: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>,
    defaultWindow = 1000n,
): Promise<T[]> {
    // `process` is absent in a browser, where only the default applies.
    const tuned = typeof process !== "undefined" ? nonBlank(process.env.FANGORN_LOG_WINDOW) : undefined;
    const window = tuned === undefined ? defaultWindow : BigInt(tuned);
    // Zero or less would never advance the loop below.
    if (window <= 0n) throw new Error(`FANGORN_LOG_WINDOW must be a positive number of blocks, not "${String(tuned)}"`);
    // Uncached: viem caches the block number for ~4s, and a caller that has just
    // awaited a receipt would otherwise scan to a head from before its own tx.
    const end = toBlock ?? (await publicClient.getBlockNumber({ cacheTime: 0 }));
    const out: T[] = [];
    for (let start = fromBlock; start <= end; start += window) {
        const stop = start + window - 1n < end ? start + window - 1n : end;
        out.push(...(await fetch(start, stop)));
    }
    return out;
}
