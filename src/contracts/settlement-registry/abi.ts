/**
 * The Settlement Registry: the on-chain rail that gates who can read a
 * settlement-priced resource. A consumer settles (pays) for a `resourceId`
 * out of band; the access worker (and anyone else) then reads `isSettled` to
 * decide whether to release the bytes.
 *
 * This is the exact ABI the deployed access worker calls
 * (`webworker/src/index.ts`), kept in lock-step so the SDK and worker agree on
 * the settlement check. Read-only here: the pay/settle write path is a separate
 * payment rail (x402 / ERC-3009 USDC) and is out of band for the SDK.
 */
export const SETTLEMENT_REGISTRY_ABI = [
	{
		inputs: [
			{ internalType: "address", name: "stealth_address", type: "address" },
			{ internalType: "bytes32", name: "resource_id", type: "bytes32" },
		],
		name: "isSettled",
		outputs: [{ internalType: "bool", name: "", type: "bool" }],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [{ internalType: "bytes32", name: "resource_id", type: "bytes32" }],
		name: "getPrice",
		outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
		stateMutability: "view",
		type: "function",
	},
] as const;
