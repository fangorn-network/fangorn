/**
 * The SubscriptionRegistry: the publisher-side paywall for storage.
 *
 * A publisher pays a USDC fee to open or renew; the off-chain upload gate reads
 * `access(publisher)` — `(registered, paidAt)` — and applies its own free-tier and
 * active-window policy. The contract deliberately stores no expiry: the window is a
 * policy decision the gate owns, so changing it does not need a migration.
 *
 * `registered` is a cross-call to the DataRegistry, so this contract never
 * duplicates publisher registration; it only prices storage on top of it.
 *
 * Generated from `cargo stylus export-abi --json`; the events are appended by hand
 * because export-abi does not emit `sol!` event definitions.
 */
export const SUBSCRIPTION_REGISTRY_ABI = [
	{
		"inputs": [
			{
				"internalType": "address",
				"name": "publisher",
				"type": "address"
			}
		],
		"name": "access",
		"outputs": [
			{
				"internalType": "bool",
				"name": "",
				"type": "bool"
			},
			{
				"internalType": "uint64",
				"name": "",
				"type": "uint64"
			}
		],
		"stateMutability": "view",
		"type": "function"
	},
	{
		"inputs": [],
		"name": "admin",
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
		"inputs": [],
		"name": "dataRegistry",
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
				"internalType": "address",
				"name": "registry",
				"type": "address"
			}
		],
		"name": "setDataRegistry",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "uint256",
				"name": "fee",
				"type": "uint256"
			}
		],
		"name": "setSubscriptionFee",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "address",
				"name": "token",
				"type": "address"
			}
		],
		"name": "setUsdc",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"inputs": [],
		"name": "subscribe",
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
			}
		],
		"name": "subscribedAt",
		"outputs": [
			{
				"internalType": "uint64",
				"name": "",
				"type": "uint64"
			}
		],
		"stateMutability": "view",
		"type": "function"
	},
	{
		"inputs": [],
		"name": "subscriptionFee",
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
		"name": "usdc",
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
				"internalType": "address",
				"name": "to",
				"type": "address"
			},
			{
				"internalType": "uint256",
				"name": "amount",
				"type": "uint256"
			}
		],
		"name": "withdrawEth",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "address",
				"name": "to",
				"type": "address"
			},
			{
				"internalType": "uint256",
				"name": "amount",
				"type": "uint256"
			}
		],
		"name": "withdrawUsdc",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"type": "event",
		"name": "Subscribed",
		"anonymous": false,
		"inputs": [
			{
				"type": "address",
				"name": "publisher",
				"internalType": "address",
				"indexed": true
			},
			{
				"type": "uint64",
				"name": "paidAt",
				"internalType": "uint64",
				"indexed": false
			}
		]
	},
	{
		"type": "event",
		"name": "SubscriptionFeeChanged",
		"anonymous": false,
		"inputs": [
			{
				"type": "uint256",
				"name": "fee",
				"internalType": "uint256",
				"indexed": false
			}
		]
	}
] as const;
