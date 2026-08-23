/**
 * The SettlementRegistry: the on-chain payment + access rail for a priced resource.
 *
 * One resource is one Semaphore group. A consumer `register`s into the group by
 * paying (an EIP-3009 USDC authorization the facilitator relays, so the consumer
 * spends no gas), then `settle`s with a zero-knowledge proof of membership from a
 * fresh stealth address. The two steps are deliberately unlinkable: the address that
 * paid and the address that reads are different, and only the group ties them.
 *
 * `isSettled(stealthAddress, resourceId)` is the question the access worker asks
 * before releasing bytes. `getPrice(resourceId) === 0` means the resource is free.
 *
 * Generated from `cargo stylus export-abi --json`; the events are appended by hand
 * because export-abi does not emit `sol!` event definitions.
 */
export const SETTLEMENT_REGISTRY_ABI = [
	{
		"inputs": [
			{
				"internalType": "bytes32",
				"name": "uid",
				"type": "bytes32"
			},
			{
				"internalType": "uint256",
				"name": "price",
				"type": "uint256"
			},
			{
				"internalType": "string",
				"name": "uri",
				"type": "string"
			}
		],
		"name": "createResource",
		"outputs": [
			{
				"internalType": "bytes32",
				"name": "",
				"type": "bytes32"
			}
		],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"inputs": [],
		"name": "getAdmin",
		"outputs": [
			{
				"internalType": "address",
				"name": "",
				"type": "address"
			}
		],
		"stateMutability": "view",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "bytes32",
				"name": "resource_id",
				"type": "bytes32"
			}
		],
		"name": "getGroupId",
		"outputs": [
			{
				"internalType": "uint256",
				"name": "",
				"type": "uint256"
			}
		],
		"stateMutability": "view",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "bytes32",
				"name": "resource_id",
				"type": "bytes32"
			}
		],
		"name": "getOwner",
		"outputs": [
			{
				"internalType": "address",
				"name": "",
				"type": "address"
			}
		],
		"stateMutability": "view",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "bytes32",
				"name": "resource_id",
				"type": "bytes32"
			}
		],
		"name": "getPrice",
		"outputs": [
			{
				"internalType": "uint256",
				"name": "",
				"type": "uint256"
			}
		],
		"stateMutability": "view",
		"type": "function"
	},
	{
		"inputs": [],
		"name": "getSemaphore",
		"outputs": [
			{
				"internalType": "address",
				"name": "",
				"type": "address"
			}
		],
		"stateMutability": "view",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "bytes32",
				"name": "resource_id",
				"type": "bytes32"
			}
		],
		"name": "getUri",
		"outputs": [
			{
				"internalType": "string",
				"name": "",
				"type": "string"
			}
		],
		"stateMutability": "view",
		"type": "function"
	},
	{
		"inputs": [],
		"name": "getUsdc",
		"outputs": [
			{
				"internalType": "address",
				"name": "",
				"type": "address"
			}
		],
		"stateMutability": "view",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "bytes32",
				"name": "resource_id",
				"type": "bytes32"
			}
		],
		"name": "isDisabled",
		"outputs": [
			{
				"internalType": "bool",
				"name": "",
				"type": "bool"
			}
		],
		"stateMutability": "view",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "bytes32",
				"name": "resource_id",
				"type": "bytes32"
			},
			{
				"internalType": "uint256",
				"name": "identity_commitment",
				"type": "uint256"
			}
		],
		"name": "isRegistered",
		"outputs": [
			{
				"internalType": "bool",
				"name": "",
				"type": "bool"
			}
		],
		"stateMutability": "view",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "address",
				"name": "stealth_address",
				"type": "address"
			},
			{
				"internalType": "bytes32",
				"name": "resource_id",
				"type": "bytes32"
			}
		],
		"name": "isSettled",
		"outputs": [
			{
				"internalType": "bool",
				"name": "",
				"type": "bool"
			}
		],
		"stateMutability": "view",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "bytes32",
				"name": "resource_id",
				"type": "bytes32"
			},
			{
				"internalType": "uint256",
				"name": "identity_commitment",
				"type": "uint256"
			},
			{
				"internalType": "address",
				"name": "from",
				"type": "address"
			},
			{
				"internalType": "uint256",
				"name": "amount",
				"type": "uint256"
			},
			{
				"internalType": "uint256",
				"name": "valid_after",
				"type": "uint256"
			},
			{
				"internalType": "uint256",
				"name": "valid_before",
				"type": "uint256"
			},
			{
				"internalType": "bytes32",
				"name": "nonce",
				"type": "bytes32"
			},
			{
				"internalType": "uint8",
				"name": "v",
				"type": "uint8"
			},
			{
				"internalType": "bytes32",
				"name": "r",
				"type": "bytes32"
			},
			{
				"internalType": "bytes32",
				"name": "s",
				"type": "bytes32"
			}
		],
		"name": "register",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "bytes32",
				"name": "resource_id",
				"type": "bytes32"
			},
			{
				"internalType": "address",
				"name": "hook",
				"type": "address"
			}
		],
		"name": "registerHook",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "address",
				"name": "publisher",
				"type": "address"
			},
			{
				"internalType": "bytes32",
				"name": "uid",
				"type": "bytes32"
			}
		],
		"name": "resourceIdFor",
		"outputs": [
			{
				"internalType": "bytes32",
				"name": "",
				"type": "bytes32"
			}
		],
		"stateMutability": "view",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "address",
				"name": "new_admin",
				"type": "address"
			}
		],
		"name": "setAdmin",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "bytes32",
				"name": "resource_id",
				"type": "bytes32"
			},
			{
				"internalType": "bool",
				"name": "disabled",
				"type": "bool"
			}
		],
		"name": "setDisabled",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "bytes32",
				"name": "resource_id",
				"type": "bytes32"
			},
			{
				"internalType": "address",
				"name": "stealth_address",
				"type": "address"
			},
			{
				"internalType": "uint256",
				"name": "merkle_tree_depth",
				"type": "uint256"
			},
			{
				"internalType": "uint256",
				"name": "merkle_tree_root",
				"type": "uint256"
			},
			{
				"internalType": "uint256",
				"name": "nullifier",
				"type": "uint256"
			},
			{
				"internalType": "uint256",
				"name": "message",
				"type": "uint256"
			},
			{
				"internalType": "uint256[8]",
				"name": "points",
				"type": "uint256[8]"
			},
			{
				"internalType": "uint8[]",
				"name": "hook_data",
				"type": "uint8[]"
			}
		],
		"name": "settle",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "bytes32",
				"name": "resource_id",
				"type": "bytes32"
			},
			{
				"internalType": "uint256",
				"name": "price",
				"type": "uint256"
			}
		],
		"name": "updatePrice",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"type": "event",
		"name": "ResourceCreated",
		"anonymous": false,
		"inputs": [
			{
				"type": "bytes32",
				"name": "resourceId",
				"internalType": "bytes32",
				"indexed": true
			},
			{
				"type": "address",
				"name": "owner",
				"internalType": "address",
				"indexed": false
			},
			{
				"type": "uint256",
				"name": "price",
				"internalType": "uint256",
				"indexed": false
			},
			{
				"type": "uint256",
				"name": "groupId",
				"internalType": "uint256",
				"indexed": false
			},
			{
				"type": "string",
				"name": "uri",
				"internalType": "string",
				"indexed": false
			}
		]
	},
	{
		"type": "event",
		"name": "MemberRegistered",
		"anonymous": false,
		"inputs": [
			{
				"type": "bytes32",
				"name": "resourceId",
				"internalType": "bytes32",
				"indexed": true
			},
			{
				"type": "uint256",
				"name": "identityCommitment",
				"internalType": "uint256",
				"indexed": false
			}
		]
	},
	{
		"type": "event",
		"name": "SettlementFinalized",
		"anonymous": false,
		"inputs": [
			{
				"type": "bytes32",
				"name": "resourceId",
				"internalType": "bytes32",
				"indexed": true
			},
			{
				"type": "uint256",
				"name": "nullifierHash",
				"internalType": "uint256",
				"indexed": true
			},
			{
				"type": "uint256",
				"name": "message",
				"internalType": "uint256",
				"indexed": false
			}
		]
	},
	{
		"type": "event",
		"name": "PriceUpdated",
		"anonymous": false,
		"inputs": [
			{
				"type": "bytes32",
				"name": "resourceId",
				"internalType": "bytes32",
				"indexed": true
			},
			{
				"type": "address",
				"name": "owner",
				"internalType": "address",
				"indexed": false
			},
			{
				"type": "uint256",
				"name": "price",
				"internalType": "uint256",
				"indexed": false
			}
		]
	},
	{
		"type": "event",
		"name": "ResourceDisabled",
		"anonymous": false,
		"inputs": [
			{
				"type": "bytes32",
				"name": "resourceId",
				"internalType": "bytes32",
				"indexed": true
			},
			{
				"type": "bool",
				"name": "disabled",
				"internalType": "bool",
				"indexed": false
			},
			{
				"type": "address",
				"name": "by",
				"internalType": "address",
				"indexed": false
			}
		]
	},
	{
		"type": "event",
		"name": "HookRegistered",
		"anonymous": false,
		"inputs": [
			{
				"type": "bytes32",
				"name": "resourceId",
				"internalType": "bytes32",
				"indexed": true
			},
			{
				"type": "address",
				"name": "hook",
				"internalType": "address",
				"indexed": false
			}
		]
	},
	{
		"type": "event",
		"name": "AdminChanged",
		"anonymous": false,
		"inputs": [
			{
				"type": "address",
				"name": "previousAdmin",
				"internalType": "address",
				"indexed": false
			},
			{
				"type": "address",
				"name": "newAdmin",
				"internalType": "address",
				"indexed": false
			}
		]
	}
] as const;
