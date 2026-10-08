/**
 * Generated from `forge inspect MembershipRegistry abi` in fangorn-network/contracts
 * (solidity/src/MembershipRegistry.sol). Regenerate, do not edit.
 */
export const MEMBERSHIP_REGISTRY_ABI = [
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
		"name": "appOfToken",
		"inputs": [
			{
				"name": "tokenId",
				"type": "uint256",
				"internalType": "uint256"
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
		"name": "approve",
		"inputs": [
			{
				"name": "to",
				"type": "address",
				"internalType": "address"
			},
			{
				"name": "tokenId",
				"type": "uint256",
				"internalType": "uint256"
			}
		],
		"outputs": [],
		"stateMutability": "nonpayable"
	},
	{
		"type": "function",
		"name": "balanceOf",
		"inputs": [
			{
				"name": "owner",
				"type": "address",
				"internalType": "address"
			}
		],
		"outputs": [
			{
				"name": "",
				"type": "uint256",
				"internalType": "uint256"
			}
		],
		"stateMutability": "view"
	},
	{
		"type": "function",
		"name": "canRead",
		"inputs": [
			{
				"name": "tokenId",
				"type": "uint256",
				"internalType": "uint256"
			},
			{
				"name": "who",
				"type": "address",
				"internalType": "address"
			}
		],
		"outputs": [
			{
				"name": "app_id",
				"type": "bytes32",
				"internalType": "bytes32"
			},
			{
				"name": "until",
				"type": "uint64",
				"internalType": "uint64"
			}
		],
		"stateMutability": "view"
	},
	{
		"type": "function",
		"name": "cancelSubscription",
		"inputs": [
			{
				"name": "",
				"type": "uint256",
				"internalType": "uint256"
			}
		],
		"outputs": [],
		"stateMutability": "payable"
	},
	{
		"type": "function",
		"name": "claim",
		"inputs": [
			{
				"name": "app_id",
				"type": "bytes32",
				"internalType": "bytes32"
			},
			{
				"name": "epoch",
				"type": "uint256",
				"internalType": "uint256"
			},
			{
				"name": "holder",
				"type": "address",
				"internalType": "address"
			},
			{
				"name": "merkleTreeDepth",
				"type": "uint256",
				"internalType": "uint256"
			},
			{
				"name": "merkleTreeRoot",
				"type": "uint256",
				"internalType": "uint256"
			},
			{
				"name": "nullifier",
				"type": "uint256",
				"internalType": "uint256"
			},
			{
				"name": "points",
				"type": "uint256[8]",
				"internalType": "uint256[8]"
			}
		],
		"outputs": [
			{
				"name": "tokenId",
				"type": "uint256",
				"internalType": "uint256"
			}
		],
		"stateMutability": "nonpayable"
	},
	{
		"type": "function",
		"name": "currentEpoch",
		"inputs": [
			{
				"name": "app_id",
				"type": "bytes32",
				"internalType": "bytes32"
			}
		],
		"outputs": [
			{
				"name": "",
				"type": "uint256",
				"internalType": "uint256"
			}
		],
		"stateMutability": "view"
	},
	{
		"type": "function",
		"name": "eip712Domain",
		"inputs": [],
		"outputs": [
			{
				"name": "fields",
				"type": "bytes1",
				"internalType": "bytes1"
			},
			{
				"name": "name",
				"type": "string",
				"internalType": "string"
			},
			{
				"name": "version",
				"type": "string",
				"internalType": "string"
			},
			{
				"name": "chainId",
				"type": "uint256",
				"internalType": "uint256"
			},
			{
				"name": "verifyingContract",
				"type": "address",
				"internalType": "address"
			},
			{
				"name": "salt",
				"type": "bytes32",
				"internalType": "bytes32"
			},
			{
				"name": "extensions",
				"type": "uint256[]",
				"internalType": "uint256[]"
			}
		],
		"stateMutability": "view"
	},
	{
		"type": "function",
		"name": "expiresAt",
		"inputs": [
			{
				"name": "tokenId",
				"type": "uint256",
				"internalType": "uint256"
			}
		],
		"outputs": [
			{
				"name": "",
				"type": "uint64",
				"internalType": "uint64"
			}
		],
		"stateMutability": "view"
	},
	{
		"type": "function",
		"name": "getApproved",
		"inputs": [
			{
				"name": "tokenId",
				"type": "uint256",
				"internalType": "uint256"
			}
		],
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
		"name": "groupOf",
		"inputs": [
			{
				"name": "app_id",
				"type": "bytes32",
				"internalType": "bytes32"
			},
			{
				"name": "epoch",
				"type": "uint256",
				"internalType": "uint256"
			}
		],
		"outputs": [
			{
				"name": "",
				"type": "uint256",
				"internalType": "uint256"
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
				"name": "usdc_",
				"type": "address",
				"internalType": "address"
			},
			{
				"name": "semaphore_",
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
		"name": "isApprovedForAll",
		"inputs": [
			{
				"name": "owner",
				"type": "address",
				"internalType": "address"
			},
			{
				"name": "operator",
				"type": "address",
				"internalType": "address"
			}
		],
		"outputs": [
			{
				"name": "",
				"type": "bool",
				"internalType": "bool"
			}
		],
		"stateMutability": "view"
	},
	{
		"type": "function",
		"name": "isRenewable",
		"inputs": [
			{
				"name": "tokenId",
				"type": "uint256",
				"internalType": "uint256"
			}
		],
		"outputs": [
			{
				"name": "",
				"type": "bool",
				"internalType": "bool"
			}
		],
		"stateMutability": "view"
	},
	{
		"type": "function",
		"name": "join",
		"inputs": [
			{
				"name": "app_id",
				"type": "bytes32",
				"internalType": "bytes32"
			},
			{
				"name": "commitment",
				"type": "uint256",
				"internalType": "uint256"
			},
			{
				"name": "salt",
				"type": "bytes32",
				"internalType": "bytes32"
			},
			{
				"name": "pay",
				"type": "tuple",
				"internalType": "struct MembershipRegistry.Payment",
				"components": [
					{
						"name": "from",
						"type": "address",
						"internalType": "address"
					},
					{
						"name": "value",
						"type": "uint256",
						"internalType": "uint256"
					},
					{
						"name": "validAfter",
						"type": "uint256",
						"internalType": "uint256"
					},
					{
						"name": "validBefore",
						"type": "uint256",
						"internalType": "uint256"
					},
					{
						"name": "nonce",
						"type": "bytes32",
						"internalType": "bytes32"
					},
					{
						"name": "v",
						"type": "uint8",
						"internalType": "uint8"
					},
					{
						"name": "r",
						"type": "bytes32",
						"internalType": "bytes32"
					},
					{
						"name": "s",
						"type": "bytes32",
						"internalType": "bytes32"
					}
				]
			}
		],
		"outputs": [],
		"stateMutability": "nonpayable"
	},
	{
		"type": "function",
		"name": "joinNonce",
		"inputs": [
			{
				"name": "app_id",
				"type": "bytes32",
				"internalType": "bytes32"
			},
			{
				"name": "epoch",
				"type": "uint256",
				"internalType": "uint256"
			},
			{
				"name": "commitment",
				"type": "uint256",
				"internalType": "uint256"
			},
			{
				"name": "salt",
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
		"stateMutability": "pure"
	},
	{
		"type": "function",
		"name": "locked",
		"inputs": [
			{
				"name": "tokenId",
				"type": "uint256",
				"internalType": "uint256"
			}
		],
		"outputs": [
			{
				"name": "",
				"type": "bool",
				"internalType": "bool"
			}
		],
		"stateMutability": "view"
	},
	{
		"type": "function",
		"name": "name",
		"inputs": [],
		"outputs": [
			{
				"name": "",
				"type": "string",
				"internalType": "string"
			}
		],
		"stateMutability": "pure"
	},
	{
		"type": "function",
		"name": "ownerOf",
		"inputs": [
			{
				"name": "tokenId",
				"type": "uint256",
				"internalType": "uint256"
			}
		],
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
		"name": "planOf",
		"inputs": [
			{
				"name": "app_id",
				"type": "bytes32",
				"internalType": "bytes32"
			}
		],
		"outputs": [
			{
				"name": "price",
				"type": "uint256",
				"internalType": "uint256"
			},
			{
				"name": "period",
				"type": "uint64",
				"internalType": "uint64"
			}
		],
		"stateMutability": "view"
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
		"name": "renewSubscription",
		"inputs": [
			{
				"name": "",
				"type": "uint256",
				"internalType": "uint256"
			},
			{
				"name": "",
				"type": "uint64",
				"internalType": "uint64"
			}
		],
		"outputs": [],
		"stateMutability": "payable"
	},
	{
		"type": "function",
		"name": "safeTransferFrom",
		"inputs": [
			{
				"name": "from",
				"type": "address",
				"internalType": "address"
			},
			{
				"name": "to",
				"type": "address",
				"internalType": "address"
			},
			{
				"name": "tokenId",
				"type": "uint256",
				"internalType": "uint256"
			}
		],
		"outputs": [],
		"stateMutability": "nonpayable"
	},
	{
		"type": "function",
		"name": "safeTransferFrom",
		"inputs": [
			{
				"name": "from",
				"type": "address",
				"internalType": "address"
			},
			{
				"name": "to",
				"type": "address",
				"internalType": "address"
			},
			{
				"name": "tokenId",
				"type": "uint256",
				"internalType": "uint256"
			},
			{
				"name": "data",
				"type": "bytes",
				"internalType": "bytes"
			}
		],
		"outputs": [],
		"stateMutability": "nonpayable"
	},
	{
		"type": "function",
		"name": "scopeOf",
		"inputs": [
			{
				"name": "app_id",
				"type": "bytes32",
				"internalType": "bytes32"
			},
			{
				"name": "epoch",
				"type": "uint256",
				"internalType": "uint256"
			}
		],
		"outputs": [
			{
				"name": "",
				"type": "uint256",
				"internalType": "uint256"
			}
		],
		"stateMutability": "pure"
	},
	{
		"type": "function",
		"name": "semaphore",
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
		"name": "setApprovalForAll",
		"inputs": [
			{
				"name": "operator",
				"type": "address",
				"internalType": "address"
			},
			{
				"name": "approved",
				"type": "bool",
				"internalType": "bool"
			}
		],
		"outputs": [],
		"stateMutability": "nonpayable"
	},
	{
		"type": "function",
		"name": "setPlan",
		"inputs": [
			{
				"name": "app_id",
				"type": "bytes32",
				"internalType": "bytes32"
			},
			{
				"name": "price",
				"type": "uint256",
				"internalType": "uint256"
			},
			{
				"name": "period",
				"type": "uint64",
				"internalType": "uint64"
			}
		],
		"outputs": [],
		"stateMutability": "nonpayable"
	},
	{
		"type": "function",
		"name": "setUser",
		"inputs": [
			{
				"name": "tokenId",
				"type": "uint256",
				"internalType": "uint256"
			},
			{
				"name": "user",
				"type": "address",
				"internalType": "address"
			},
			{
				"name": "expires",
				"type": "uint64",
				"internalType": "uint64"
			}
		],
		"outputs": [],
		"stateMutability": "nonpayable"
	},
	{
		"type": "function",
		"name": "setUserBySig",
		"inputs": [
			{
				"name": "tokenId",
				"type": "uint256",
				"internalType": "uint256"
			},
			{
				"name": "user",
				"type": "address",
				"internalType": "address"
			},
			{
				"name": "expires",
				"type": "uint64",
				"internalType": "uint64"
			},
			{
				"name": "deadline",
				"type": "uint256",
				"internalType": "uint256"
			},
			{
				"name": "signature",
				"type": "bytes",
				"internalType": "bytes"
			}
		],
		"outputs": [],
		"stateMutability": "nonpayable"
	},
	{
		"type": "function",
		"name": "supportsInterface",
		"inputs": [
			{
				"name": "id",
				"type": "bytes4",
				"internalType": "bytes4"
			}
		],
		"outputs": [
			{
				"name": "",
				"type": "bool",
				"internalType": "bool"
			}
		],
		"stateMutability": "view"
	},
	{
		"type": "function",
		"name": "symbol",
		"inputs": [],
		"outputs": [
			{
				"name": "",
				"type": "string",
				"internalType": "string"
			}
		],
		"stateMutability": "pure"
	},
	{
		"type": "function",
		"name": "tokenIdOf",
		"inputs": [
			{
				"name": "app_id",
				"type": "bytes32",
				"internalType": "bytes32"
			},
			{
				"name": "holder",
				"type": "address",
				"internalType": "address"
			}
		],
		"outputs": [
			{
				"name": "",
				"type": "uint256",
				"internalType": "uint256"
			}
		],
		"stateMutability": "pure"
	},
	{
		"type": "function",
		"name": "tokenURI",
		"inputs": [
			{
				"name": "tokenId",
				"type": "uint256",
				"internalType": "uint256"
			}
		],
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
		"name": "transferFrom",
		"inputs": [
			{
				"name": "from",
				"type": "address",
				"internalType": "address"
			},
			{
				"name": "to",
				"type": "address",
				"internalType": "address"
			},
			{
				"name": "tokenId",
				"type": "uint256",
				"internalType": "uint256"
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
		"type": "function",
		"name": "usdc",
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
		"name": "userExpires",
		"inputs": [
			{
				"name": "tokenId",
				"type": "uint256",
				"internalType": "uint256"
			}
		],
		"outputs": [
			{
				"name": "",
				"type": "uint256",
				"internalType": "uint256"
			}
		],
		"stateMutability": "view"
	},
	{
		"type": "function",
		"name": "userNonces",
		"inputs": [
			{
				"name": "",
				"type": "uint256",
				"internalType": "uint256"
			}
		],
		"outputs": [
			{
				"name": "",
				"type": "uint256",
				"internalType": "uint256"
			}
		],
		"stateMutability": "view"
	},
	{
		"type": "function",
		"name": "userOf",
		"inputs": [
			{
				"name": "tokenId",
				"type": "uint256",
				"internalType": "uint256"
			}
		],
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
		"type": "event",
		"name": "AdminChanged",
		"inputs": [
			{
				"name": "previousAdmin",
				"type": "address",
				"indexed": false,
				"internalType": "address"
			},
			{
				"name": "newAdmin",
				"type": "address",
				"indexed": false,
				"internalType": "address"
			}
		],
		"anonymous": false
	},
	{
		"type": "event",
		"name": "Approval",
		"inputs": [
			{
				"name": "owner",
				"type": "address",
				"indexed": true,
				"internalType": "address"
			},
			{
				"name": "approved",
				"type": "address",
				"indexed": true,
				"internalType": "address"
			},
			{
				"name": "tokenId",
				"type": "uint256",
				"indexed": true,
				"internalType": "uint256"
			}
		],
		"anonymous": false
	},
	{
		"type": "event",
		"name": "ApprovalForAll",
		"inputs": [
			{
				"name": "owner",
				"type": "address",
				"indexed": true,
				"internalType": "address"
			},
			{
				"name": "operator",
				"type": "address",
				"indexed": true,
				"internalType": "address"
			},
			{
				"name": "approved",
				"type": "bool",
				"indexed": false,
				"internalType": "bool"
			}
		],
		"anonymous": false
	},
	{
		"type": "event",
		"name": "Claimed",
		"inputs": [
			{
				"name": "app_id",
				"type": "bytes32",
				"indexed": true,
				"internalType": "bytes32"
			},
			{
				"name": "epoch",
				"type": "uint256",
				"indexed": true,
				"internalType": "uint256"
			},
			{
				"name": "tokenId",
				"type": "uint256",
				"indexed": true,
				"internalType": "uint256"
			},
			{
				"name": "holder",
				"type": "address",
				"indexed": false,
				"internalType": "address"
			}
		],
		"anonymous": false
	},
	{
		"type": "event",
		"name": "EIP712DomainChanged",
		"inputs": [],
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
		"name": "Joined",
		"inputs": [
			{
				"name": "app_id",
				"type": "bytes32",
				"indexed": true,
				"internalType": "bytes32"
			},
			{
				"name": "epoch",
				"type": "uint256",
				"indexed": true,
				"internalType": "uint256"
			},
			{
				"name": "commitment",
				"type": "uint256",
				"indexed": false,
				"internalType": "uint256"
			}
		],
		"anonymous": false
	},
	{
		"type": "event",
		"name": "Locked",
		"inputs": [
			{
				"name": "tokenId",
				"type": "uint256",
				"indexed": false,
				"internalType": "uint256"
			}
		],
		"anonymous": false
	},
	{
		"type": "event",
		"name": "PlanSet",
		"inputs": [
			{
				"name": "app_id",
				"type": "bytes32",
				"indexed": true,
				"internalType": "bytes32"
			},
			{
				"name": "price",
				"type": "uint256",
				"indexed": false,
				"internalType": "uint256"
			},
			{
				"name": "period",
				"type": "uint64",
				"indexed": false,
				"internalType": "uint64"
			}
		],
		"anonymous": false
	},
	{
		"type": "event",
		"name": "SubscriptionUpdate",
		"inputs": [
			{
				"name": "tokenId",
				"type": "uint256",
				"indexed": true,
				"internalType": "uint256"
			},
			{
				"name": "expiration",
				"type": "uint64",
				"indexed": false,
				"internalType": "uint64"
			}
		],
		"anonymous": false
	},
	{
		"type": "event",
		"name": "Transfer",
		"inputs": [
			{
				"name": "from",
				"type": "address",
				"indexed": true,
				"internalType": "address"
			},
			{
				"name": "to",
				"type": "address",
				"indexed": true,
				"internalType": "address"
			},
			{
				"name": "tokenId",
				"type": "uint256",
				"indexed": true,
				"internalType": "uint256"
			}
		],
		"anonymous": false
	},
	{
		"type": "event",
		"name": "Unlocked",
		"inputs": [
			{
				"name": "tokenId",
				"type": "uint256",
				"indexed": false,
				"internalType": "uint256"
			}
		],
		"anonymous": false
	},
	{
		"type": "event",
		"name": "UpdateUser",
		"inputs": [
			{
				"name": "tokenId",
				"type": "uint256",
				"indexed": true,
				"internalType": "uint256"
			},
			{
				"name": "user",
				"type": "address",
				"indexed": true,
				"internalType": "address"
			},
			{
				"name": "expires",
				"type": "uint64",
				"indexed": false,
				"internalType": "uint64"
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
		"name": "AlreadyClaimed",
		"inputs": []
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
		"name": "ERC721IncorrectOwner",
		"inputs": [
			{
				"name": "sender",
				"type": "address",
				"internalType": "address"
			},
			{
				"name": "tokenId",
				"type": "uint256",
				"internalType": "uint256"
			},
			{
				"name": "owner",
				"type": "address",
				"internalType": "address"
			}
		]
	},
	{
		"type": "error",
		"name": "ERC721InsufficientApproval",
		"inputs": [
			{
				"name": "operator",
				"type": "address",
				"internalType": "address"
			},
			{
				"name": "tokenId",
				"type": "uint256",
				"internalType": "uint256"
			}
		]
	},
	{
		"type": "error",
		"name": "ERC721InvalidApprover",
		"inputs": [
			{
				"name": "approver",
				"type": "address",
				"internalType": "address"
			}
		]
	},
	{
		"type": "error",
		"name": "ERC721InvalidOperator",
		"inputs": [
			{
				"name": "operator",
				"type": "address",
				"internalType": "address"
			}
		]
	},
	{
		"type": "error",
		"name": "ERC721InvalidOwner",
		"inputs": [
			{
				"name": "owner",
				"type": "address",
				"internalType": "address"
			}
		]
	},
	{
		"type": "error",
		"name": "ERC721InvalidReceiver",
		"inputs": [
			{
				"name": "receiver",
				"type": "address",
				"internalType": "address"
			}
		]
	},
	{
		"type": "error",
		"name": "ERC721InvalidSender",
		"inputs": [
			{
				"name": "sender",
				"type": "address",
				"internalType": "address"
			}
		]
	},
	{
		"type": "error",
		"name": "ERC721NonexistentToken",
		"inputs": [
			{
				"name": "tokenId",
				"type": "uint256",
				"internalType": "uint256"
			}
		]
	},
	{
		"type": "error",
		"name": "Expired",
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
		"name": "InvalidShortString",
		"inputs": []
	},
	{
		"type": "error",
		"name": "NoGroup",
		"inputs": []
	},
	{
		"type": "error",
		"name": "NoPlan",
		"inputs": []
	},
	{
		"type": "error",
		"name": "NonceNotBound",
		"inputs": []
	},
	{
		"type": "error",
		"name": "NotInitializing",
		"inputs": []
	},
	{
		"type": "error",
		"name": "NotTransferable",
		"inputs": []
	},
	{
		"type": "error",
		"name": "Reentrancy",
		"inputs": []
	},
	{
		"type": "error",
		"name": "SafeERC20FailedOperation",
		"inputs": [
			{
				"name": "token",
				"type": "address",
				"internalType": "address"
			}
		]
	},
	{
		"type": "error",
		"name": "StringTooLong",
		"inputs": [
			{
				"name": "str",
				"type": "string",
				"internalType": "string"
			}
		]
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
	},
	{
		"type": "error",
		"name": "UseJoinAndClaim",
		"inputs": []
	},
	{
		"type": "error",
		"name": "WrongAmount",
		"inputs": []
	}
] as const;
