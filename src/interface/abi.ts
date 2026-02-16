// The data source registry contract abi
export const DS_REGISTRY_ABI = [
	{
		name: "registerDataSource",
		type: "function",
		stateMutability: "payable",
		inputs: [{ name: "name", type: "string" }],
		outputs: [{ name: "id", type: "bytes32" }],
	},
	{
		name: "updateDataSource",
		type: "function",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "vaultId", type: "bytes32" },
			{ name: "newRoot", type: "bytes32" },
			{ name: "newManifestCid", type: "string" },
		],
		outputs: [],
	},
	{
		name: "pay",
		type: "function",
		stateMutability: "nonpayable",
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
		name: "getDataSource",
		type: "function",
		stateMutability: "view",
		inputs: [{ name: "id", type: "bytes32" }],
		outputs: [
			{ name: "poseidonRoot", type: "bytes32" },
			{ name: "manifestCid", type: "string" },
			{ name: "owner", type: "address" },
			{ name: "name", type: "string" },
		],
	},
	{
		name: "checkSettlement",
		type: "function",
		stateMutability: "view",
		inputs: [
			{ name: "commitment", type: "bytes32" },
			{ name: "user", type: "address" },
		],
		outputs: [{ name: "hasAccess", type: "bool" }],
	},
	{
		name: "getOwnedDataSources",
		type: "function",
		stateMutability: "view",
		inputs: [{ name: "owner", type: "address" }],
		outputs: [{ type: "bytes32[]" }],
	},
	// Events
	{
		name: "DataSourceCreated",
		type: "event",
		inputs: [
			{ name: "id", type: "bytes32", indexed: true },
			{ name: "owner", type: "address", indexed: true },
			{ name: "name", type: "string", indexed: false },
		],
	},
	{
		name: "DataSourceUpdated",
		type: "event",
		inputs: [
			{ name: "id", type: "bytes32", indexed: true },
			{ name: "newRoot", type: "bytes32", indexed: false },
			{ name: "newManifestCid", type: "string", indexed: false },
		],
	},
	// Errors
	{
		name: "AlreadyPaid",
		type: "error",
		inputs: [],
	},
] as const;
