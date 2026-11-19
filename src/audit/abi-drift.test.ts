import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type Abi,
	type AbiEvent,
	toEventSelector,
	toEventSignature,
	toFunctionSignature,
} from "viem";
import { DATA_REGISTRY_ABI } from "../contracts/data-registry/abi.js";
import { SETTLEMENT_REGISTRY_ABI } from "../contracts/settlement-registry/abi.js";

// Audit: the SDK's hand-copied ABIs against a forge build of the contracts.
// Point FANGORN_CONTRACTS_DIR at a checkout that has been `forge build`-ed; skipped otherwise.
const CONTRACTS =
	process.env.FANGORN_CONTRACTS_DIR ??
	resolve(import.meta.dirname, "../../../contracts");
const built = (name: string) => `${CONTRACTS}/out/${name}.sol/${name}.json`;

/** One comparable line per ABI item: name, types, indexing, outputs, mutability. */
function lines(abi: Abi): Set<string> {
	return new Set(
		abi.map((i) => {
			if (i.type === "event")
				return `event ${toEventSignature(i)} ${i.inputs.map((x) => (x.indexed ? "i" : "-")).join("")}`;
			if (i.type === "function")
				return `fn ${toFunctionSignature(i)} -> (${i.outputs.map((o) => o.type).join(",")}) ${i.stateMutability}`;
			if (i.type === "error")
				return `error ${i.name}(${i.inputs.map((x) => x.type).join(",")})`;
			return i.type;
		}),
	);
}

describe.each([
	["DataRegistry", DATA_REGISTRY_ABI as Abi],
	["SettlementRegistry", SETTLEMENT_REGISTRY_ABI as Abi],
])("%s ABI vs forge build", (name, sdk) => {
	it.skipIf(!existsSync(built(name)))("matches item for item", () => {
		const chain = (
			JSON.parse(readFileSync(built(name), "utf-8")) as { abi: Abi }
		).abi;
		const a = lines(sdk);
		const b = lines(chain);
		expect({
			sdkOnly: [...a].filter((x) => !b.has(x)),
			chainOnly: [...b].filter((x) => !a.has(x)),
		}).toEqual({ sdkOnly: [], chainOnly: [] });
	});
});

describe("Updated event topic", () => {
	it.skipIf(!existsSync(built("DataRegistry")))(
		"the SDK filters logs on the topic the contract emits",
		() => {
			const chain = (
				JSON.parse(readFileSync(built("DataRegistry"), "utf-8")) as { abi: Abi }
			).abi;
			const updated = (abi: Abi) =>
				abi.find(
					(i): i is AbiEvent => i.type === "event" && i.name === "Updated",
				);
			const sdk = updated(DATA_REGISTRY_ABI as Abi);
			const onChain = updated(chain);
			if (!sdk || !onChain) throw new Error("no Updated event");
			expect(toEventSelector(sdk)).toBe(toEventSelector(onChain));
		},
	);
});
