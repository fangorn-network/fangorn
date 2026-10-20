import { describe, expect, it } from "vitest";
import type { PublicClient } from "viem";
import { getLogsInWindows } from "./logs.js";
import { BaseSepoliaConfig, FangornConfig } from "../config.js";

const spans = async (from: bigint, to: bigint, window?: bigint) => {
	const calls: [bigint, bigint][] = [];
	await getLogsInWindows({} as PublicClient, from, to, (a, b) => (calls.push([a, b]), []), window);
	return calls;
};

describe("getLogsInWindows", () => {
	it("covers the range in consecutive windows no wider than the network's", async () => {
		expect(await spans(0n, 24_999n, BaseSepoliaConfig.logWindow)).toEqual([[0n, 9_999n], [10_000n, 19_999n], [20_000n, 24_999n]]);
	});

	it("falls back to 1000 blocks for a network that sets no window", async () => {
		expect(await spans(0n, 1_500n, { ...FangornConfig, logWindow: undefined }.logWindow)).toEqual([[0n, 999n], [1_000n, 1_500n]]);
	});

	it("lets FANGORN_LOG_WINDOW override the network's window", async () => {
		process.env.FANGORN_LOG_WINDOW = "500";
		try { expect(await spans(0n, 999n, FangornConfig.logWindow)).toEqual([[0n, 499n], [500n, 999n]]); }
		finally { delete process.env.FANGORN_LOG_WINDOW; }
	});
});
