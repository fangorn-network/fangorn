export const SETTLEMENT_REGISTRY_ABI = [
    {
        "inputs": [],
        "name": "AlreadyRegistered",
        "type": "error"
    },
    {
        "inputs": [],
        "name": "AlreadySettled",
        "type": "error"
    },
    {
        "inputs": [],
        "name": "GroupCreationFailed",
        "type": "error"
    },
    {
        "inputs": [],
        "name": "HookFailed",
        "type": "error"
    },
    {
        "inputs": [],
        "name": "IncorrectPaymentAmount",
        "type": "error"
    },
    {
        "inputs": [],
        "name": "NotAdmin",
        "type": "error"
    },
    {
        "inputs": [],
        "name": "NotAuthorizedRegistry",
        "type": "error"
    },
    {
        "inputs": [],
        "name": "NotResourceOwner",
        "type": "error"
    },
    {
        "inputs": [],
        "name": "ResourceNotFound",
        "type": "error"
    },
    {
        "inputs": [],
        "name": "TransferFailed",
        "type": "error"
    },
    {
        "inputs": [],
        "name": "VerificationFailed",
        "type": "error"
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
            },
            {
                "internalType": "address",
                "name": "owner",
                "type": "address"
            }
        ],
        "name": "createResource",
        "outputs": [
            {
                "internalType": "uint256",
                "name": "",
                "type": "uint256"
            }
        ],
        "stateMutability": "nonpayable",
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
                "internalType": "address",
                "name": "to",
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
        "stateMutability": "payable",
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
                "name": "registry",
                "type": "address"
            },
            {
                "internalType": "bool",
                "name": "authorized",
                "type": "bool"
            }
        ],
        "name": "setRegistry",
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
            },
            {
                "internalType": "address",
                "name": "owner",
                "type": "address"
            }
        ],
        "name": "updatePrice",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    }
] as const;

