import { describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import { MemRegistry, memoryNetwork, TEST_APP } from "./test/testbed.js";
import { sdkSuite, take } from "./test/sdk-suite.js";

// The SDK end to end on an in-memory network: the registry and storage are mocks.
// The same suite runs on the contracts in src/e2e/sdk.e2e.test.ts.
describe("Fangorn SDK (in memory)", () => {
	sdkSuite(() => Promise.resolve(memoryNetwork()));
});

describe("Fangorn subscriptions (in memory only)", () => {
	// An RPC that leaves a log out can't be staged on a real chain.
	it("a dropped log entry can't hide its changes from the next one", async () => {
		const net = memoryNetwork();
		const pub = await net.client();
		await pub.initRepo("feed"); // t = 1
		await pub.upload("feed", { n: 1 }, "t", "a"); // t = 2
		await pub.upload("feed", { n: 2 }, "t", "b"); // t = 3: the RPC leaves this one out
		await pub.upload("feed", { n: 3 }, "t", "c"); // t = 4

		class LossyRegistry extends MemRegistry {
			async log(...args: Parameters<MemRegistry["log"]>) {
				return (await super.log(...args)).filter((e) => e.t !== 3n);
			}
		}
		const reader = await net.client(TEST_APP, generatePrivateKey(), LossyRegistry);

		const changes = await take(reader.subscribeApp({ fromBlock: 0n }), 2);
		expect(changes.map((c) => c.puts.map((r) => r.id).sort())).toEqual([["a"], ["b", "c"]]);
	});
});
