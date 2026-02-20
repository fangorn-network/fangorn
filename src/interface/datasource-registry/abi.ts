// The data source registry contract abi
export const DS_REGISTRY_ABI = [
	{
		name: "registerDataSource",
		type: "function",
		stateMutability: "nonpayable", // for now...
		inputs: [
			{ name: "name", type: "string" },
			{ name: "agentId", type: "string" },
		],
		outputs: [{ name: "id", type: "bytes32" }],
	},
	{
		name: "updateDataSource",
		type: "function",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "name", type: "string" },
			{ name: "newManifestCid", type: "string" },
		],
		outputs: [],
	},
	{
		name: "getDataSource",
		type: "function",
		stateMutability: "view",
		inputs: [
			{ name: "owner", type: "address" },
			{ name: "name", type: "string" },
		],
		outputs: [{ name: "manifestCid", type: "string" }],
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
			{ name: "newManifestCid", type: "string", indexed: false },
		],
	},

	// Errors
	{
		name: "NotOwner",
		type: "error",
		inputs: [],
	},
	{
		name: "DataSourceNotFound",
		type: "error",
		inputs: [],
	},
	{
		name: "DataSourceAlreadyExists",
		type: "error",
		inputs: [],
	},
] as const;
