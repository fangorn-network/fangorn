export const SETTLEMENT_TRACKER_ABI = [
	{
		name: "pay",
		type: "function",
		stateMutability: "payable",
		inputs: [
			{ name: "commitment", type: "bytes32" },
			{ name: "from", type: "address" },
			{ name: "to", type: "address" },
			{ name: "value", type: "uint256" },
			{ name: "validAfter", type: "uint256" },
			{ name: "validBefore", type: "uint256" },
			{ name: "nonce", type: "bytes32" },
			{ name: "v", type: "uint8" },
			{ name: "r", type: "bytes32" },
			{ name: "s", type: "bytes32" },
		],
		outputs: [],
	},
	// Read functions
	{
		name: "checkSettlement",
		type: "function",
		stateMutability: "view",
		inputs: [
			{ name: "commitment", type: "bytes32" },
			{ name: "user", type: "address" },
		],
		outputs: [{ name: "amount", type: "uint256" }],
	},
	// events (cargo stylus isn't generating these, weird)
	{
		name: "SettlementRecordedd",
		type: "event",
		inputs: [
			{ name: "hash", type: "bytes32", indexed: true },
			{ name: "amount", type: "uint256", indexed: false },
		],
	},
	// errors
	{
		name: "TransferFailed",
		type: "error",
		inputs: [],
	},
];
