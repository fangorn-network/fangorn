import type { PublicClient } from "viem";

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
 */
export async function getLogsInWindows<T>(
    publicClient: PublicClient,
    fromBlock: bigint,
    toBlock: bigint | undefined,
    fetch: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>,
): Promise<T[]> {
    // `process` is absent in a browser, where only the default applies.
    const window = BigInt((typeof process !== "undefined" ? process.env.FANGORN_LOG_WINDOW : undefined) ?? 1000);
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
