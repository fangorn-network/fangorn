import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeAbiParameters, keccak256, stringToHex, type Hex } from "viem";
import {
	DATA_REGISTRY_ABI,
	repoId,
	type UpdateEntry,
} from "../contracts/index.js";
import { chainNetwork, type ChainNetwork, skipChain } from "../test/testbed.js";

// An entry read from the log is the leaf the contract committed to: its
// mountain range root is rebuilt from `log()` alone.
const tag = (s: string) => stringToHex(s, { size: 32 });
const leaf = (e: UpdateEntry): Hex =>
	keccak256(
		encodeAbiParameters(
			[
				{ type: "bytes32" },
				{ type: "address" },
				{ type: "bytes32" },
				{ type: "uint64" },
				{ type: "bytes32" },
				{ type: "uint64" },
			],
			[
				tag("leaf"),
				e.publisher,
				repoId(e.repo),
				BigInt(e.pos),
				e.head,
				e.timestamp,
			],
		),
	);

describe.skipIf(skipChain)("The update log (contracts on anvil)", () => {
	let net: ChainNetwork;
	beforeAll(async () => {
		net = await chainNetwork();
	}, 120_000);
	afterAll(() => net.stop());

	it("an entry carries its block's timestamp, and rebuilds the contract's leaf", async () => {
		const fangorn = await net.client();
		await fangorn.initRepo("r");
		const [entry] = await fangorn.getRegistry().log({}, 0n);
		const block = await net.chain.getBlock({ blockNumber: entry.t });
		expect(entry.timestamp).toBe(block.timestamp);

		const root = await net.chain.readContract({
			address: net.config.dataRegistryContractAddress,
			abi: DATA_REGISTRY_ABI,
			functionName: "logRoot",
		});
		const mmr = encodeAbiParameters(
			[{ type: "bytes32" }, { type: "uint64" }, { type: "bytes32[]" }],
			[tag("mmr"), 1n, [leaf(entry)]],
		);
		expect(keccak256(mmr)).toBe(root);
	}, 60_000);
});
