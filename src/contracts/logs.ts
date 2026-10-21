import type { PublicClient } from "viem";
import { nonBlank } from "../config.js";

/**
 * Run `fetch` over [fromBlock, toBlock] in consecutive block windows and
 * concatenate the results, oldest window first.
 *
 * RPC providers limit how many blocks one `eth_getLogs` call can cover (the
 * Base Sepolia one 50,000, sepolia.base.org 200), and a call past the limit fails
 * outright, taking whatever depends on it (a catch-up, a directory listing) with
 * it. Each network's config says what its RPC takes (`AppConfig.logWindow`, passed
 * here as `defaultWindow`); `FANGORN_LOG_WINDOW` overrides it, for a private RPC.
 */
export async function getLogsInWindows<T>(
    publicClient: PublicClient,
    fromBlock: bigint,
    toBlock: bigint | undefined,
    fetch: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>,
    defaultWindow: bigint | undefined = 1000n,
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
