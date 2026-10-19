/**
 * Generated from `forge inspect DataRegistry abi --json` in fangorn-network/contracts
 * (solidity/src/DataRegistry.sol). Regenerate, do not edit.
 */
export const DATA_REGISTRY_ABI = [
	{
		"type": "constructor",
		"inputs": [],
		"stateMutability": "nonpayable"
	},
	{
		"type": "function",
		"name": "UPGRADE_INTERFACE_VERSION",
		"inputs": [],
		"outputs": [
			{
				"name": "",
				"type": "string",
				"internalType": "string"
			}
		],
		"stateMutability": "view"
	},
	{
		"type": "function",
		"name": "admin",
		"inputs": [],
		"outputs": [
			{
				"name": "",
				"type": "address",
				"internalType": "address"
			}
		],
		"stateMutability": "view"
	},
	{
		"type": "function",
		"name": "appRegistry",
		"inputs": [],
		"outputs": [
			{
				"name": "",
				"type": "address",
				"internalType": "address"
			}
		],
		"stateMutability": "view"
	},
	{
		"type": "function",
		"name": "commitStateRoot",
		"inputs": [
			{
				"name": "app_id",
				"type": "bytes32",
				"internalType": "bytes32"
			},
			{
				"name": "publisher",
				"type": "address",
				"internalType": "address"
			},
			{
				"name": "subspace_id",
				"type": "bytes32",
				"internalType": "bytes32"
			},
			{
				"name": "old_root",
				"type": "bytes32",
				"internalType": "bytes32"
			},
			{
				"name": "new_root",
				"type": "bytes32",
				"internalType": "bytes32"
			}
		],
		"outputs": [],
		"stateMutability": "nonpayable"
	},
	{
		"type": "function",
		"name": "getNamespaceHead",
		"inputs": [
			{
				"name": "app_id",
				"type": "bytes32",
				"internalType": "bytes32"
			},
			{
				"name": "publisher",
				"type": "address",
				"internalType": "address"
			},
			{
				"name": "subspace_id",
				"type": "bytes32",
				"internalType": "bytes32"
			}
		],
		"outputs": [
			{
				"name": "",
				"type": "bytes32",
				"internalType": "bytes32"
			}
		],
		"stateMutability": "view"
	},
	{
		"type": "function",
		"name": "initialize",
		"inputs": [
			{
				"name": "admin_",
				"type": "address",
				"internalType": "address"
			},
			{
				"name": "appRegistry_",
				"type": "address",
				"internalType": "address"
			}
		],
		"outputs": [],
		"stateMutability": "nonpayable"
	},
	{
		"type": "function",
		"name": "proxiableUUID",
		"inputs": [],
		"outputs": [
			{
				"name": "",
				"type": "bytes32",
				"internalType": "bytes32"
			}
		],
		"stateMutability": "view"
	},
	{
		"type": "function",
		"name": "setAdmin",
		"inputs": [
			{
				"name": "new_admin",
				"type": "address",
				"internalType": "address"
			}
		],
		"outputs": [],
		"stateMutability": "nonpayable"
	},
	{
		"type": "function",
		"name": "setAppRegistry",
		"inputs": [
			{
				"name": "registry",
				"type": "address",
				"internalType": "address"
			}
		],
		"outputs": [],
		"stateMutability": "nonpayable"
	},
	{
		"type": "function",
		"name": "upgradeToAndCall",
		"inputs": [
			{
				"name": "newImplementation",
				"type": "address",
				"internalType": "address"
			},
			{
				"name": "data",
				"type": "bytes",
				"internalType": "bytes"
			}
		],
		"outputs": [],
		"stateMutability": "payable"
	},
	{
		"type": "event",
		"name": "AdminChanged",
		"inputs": [
			{
				"name": "previous_admin",
				"type": "address",
				"indexed": false,
				"internalType": "address"
			},
			{
				"name": "new_admin",
				"type": "address",
				"indexed": false,
				"internalType": "address"
			}
		],
		"anonymous": false
	},
	{
		"type": "event",
		"name": "Initialized",
		"inputs": [
			{
				"name": "version",
				"type": "uint64",
				"indexed": false,
				"internalType": "uint64"
			}
		],
		"anonymous": false
	},
	{
		"type": "event",
		"name": "StateCommitted",
		"inputs": [
			{
				"name": "namespace_key",
				"type": "bytes32",
				"indexed": true,
				"internalType": "bytes32"
			},
			{
				"name": "app_id",
				"type": "bytes32",
				"indexed": true,
				"internalType": "bytes32"
			},
			{
				"name": "publisher",
				"type": "address",
				"indexed": true,
				"internalType": "address"
			},
			{
				"name": "subspace_id",
				"type": "bytes32",
				"indexed": false,
				"internalType": "bytes32"
			},
			{
				"name": "old_root",
				"type": "bytes32",
				"indexed": false,
				"internalType": "bytes32"
			},
			{
				"name": "new_root",
				"type": "bytes32",
				"indexed": false,
				"internalType": "bytes32"
			}
		],
		"anonymous": false
	},
	{
		"type": "event",
		"name": "Upgraded",
		"inputs": [
			{
				"name": "implementation",
				"type": "address",
				"indexed": true,
				"internalType": "address"
			}
		],
		"anonymous": false
	},
	{
		"type": "error",
		"name": "AddressEmptyCode",
		"inputs": [
			{
				"name": "target",
				"type": "address",
				"internalType": "address"
			}
		]
	},
	{
		"type": "error",
		"name": "ERC1967InvalidImplementation",
		"inputs": [
			{
				"name": "implementation",
				"type": "address",
				"internalType": "address"
			}
		]
	},
	{
		"type": "error",
		"name": "ERC1967NonPayable",
		"inputs": []
	},
	{
		"type": "error",
		"name": "FailedCall",
		"inputs": []
	},
	{
		"type": "error",
		"name": "InvalidInitialization",
		"inputs": []
	},
	{
		"type": "error",
		"name": "NotInitializing",
		"inputs": []
	},
	{
		"type": "error",
		"name": "StaleStateRoot",
		"inputs": []
	},
	{
		"type": "error",
		"name": "UUPSUnauthorizedCallContext",
		"inputs": []
	},
	{
		"type": "error",
		"name": "UUPSUnsupportedProxiableUUID",
		"inputs": [
			{
				"name": "slot",
				"type": "bytes32",
				"internalType": "bytes32"
			}
		]
	},
	{
		"type": "error",
		"name": "Unauthorized",
		"inputs": []
	}
] as const;
