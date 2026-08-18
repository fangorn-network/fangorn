export const APP_REGISTRY_ABI = [
    {
        "inputs": [],
        "name": "AlreadyRegistered",
        "type": "error"
    },
    {
        "inputs": [],
        "name": "AppAlreadyRegistered",
        "type": "error"
    },
    {
        "inputs": [],
        "name": "AppNotFound",
        "type": "error"
    },
    {
        "inputs": [],
        "name": "AppSuspendedErr",
        "type": "error"
    },
    {
        "inputs": [],
        "name": "JoinFeeRequired",
        "type": "error"
    },
    {
        "inputs": [],
        "name": "NotRegistered",
        "type": "error"
    },
    {
        "inputs": [],
        "name": "PublisherSuspendedErr",
        "type": "error"
    },
    {
        "inputs": [],
        "name": "TermsMismatch",
        "type": "error"
    },
    {
        "inputs": [],
        "name": "TermsNotSet",
        "type": "error"
    },
    {
        "inputs": [],
        "name": "TransferFailed",
        "type": "error"
    },
    {
        "inputs": [],
        "name": "Unauthorized",
        "type": "error"
    },
    {
        "inputs": [
            {
                "internalType": "bytes32",
                "name": "app_id",
                "type": "bytes32"
            },
            {
                "internalType": "address",
                "name": "publisher",
                "type": "address"
            }
        ],
        "name": "acceptedTerms",
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
        "inputs": [
            {
                "internalType": "bytes32",
                "name": "app_id",
                "type": "bytes32"
            }
        ],
        "name": "appFee",
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
                "name": "app_id",
                "type": "bytes32"
            }
        ],
        "name": "appTerms",
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
                "internalType": "bytes32",
                "name": "app_id",
                "type": "bytes32"
            }
        ],
        "name": "appTermsUri",
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
        "inputs": [
            {
                "internalType": "bytes32",
                "name": "app_id",
                "type": "bytes32"
            }
        ],
        "name": "getAppOwner",
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
                "name": "app_id",
                "type": "bytes32"
            }
        ],
        "name": "isAppSuspended",
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
                "name": "app_id",
                "type": "bytes32"
            },
            {
                "internalType": "address",
                "name": "publisher",
                "type": "address"
            }
        ],
        "name": "isRegisteredForApp",
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
                "name": "app_id",
                "type": "bytes32"
            },
            {
                "internalType": "address",
                "name": "publisher",
                "type": "address"
            }
        ],
        "name": "joinInfo",
        "outputs": [
            {
                "internalType": "bytes32",
                "name": "",
                "type": "bytes32"
            },
            {
                "internalType": "string",
                "name": "",
                "type": "string"
            },
            {
                "internalType": "uint256",
                "name": "",
                "type": "uint256"
            },
            {
                "internalType": "uint8",
                "name": "",
                "type": "uint8"
            },
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
                "name": "app_id",
                "type": "bytes32"
            },
            {
                "internalType": "bytes32",
                "name": "terms_hash",
                "type": "bytes32"
            },
            {
                "internalType": "string",
                "name": "terms_uri",
                "type": "string"
            },
            {
                "internalType": "uint256",
                "name": "fee",
                "type": "uint256"
            }
        ],
        "name": "registerApp",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "bytes32",
                "name": "app_id",
                "type": "bytes32"
            },
            {
                "internalType": "bytes32",
                "name": "terms_hash",
                "type": "bytes32"
            }
        ],
        "name": "registerForApp",
        "outputs": [],
        "stateMutability": "payable",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "bytes32",
                "name": "app_id",
                "type": "bytes32"
            },
            {
                "internalType": "address",
                "name": "publisher",
                "type": "address"
            }
        ],
        "name": "reinstateForApp",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "bytes32",
                "name": "app_id",
                "type": "bytes32"
            }
        ],
        "name": "reinstateApp",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "bytes32",
                "name": "app_id",
                "type": "bytes32"
            }
        ],
        "name": "suspendApp",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "bytes32",
                "name": "app_id",
                "type": "bytes32"
            },
            {
                "internalType": "uint256",
                "name": "fee",
                "type": "uint256"
            }
        ],
        "name": "setAppFee",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "bytes32",
                "name": "app_id",
                "type": "bytes32"
            },
            {
                "internalType": "bytes32",
                "name": "terms_hash",
                "type": "bytes32"
            },
            {
                "internalType": "string",
                "name": "terms_uri",
                "type": "string"
            }
        ],
        "name": "setAppTerms",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "bytes32",
                "name": "app_id",
                "type": "bytes32"
            },
            {
                "internalType": "address",
                "name": "publisher",
                "type": "address"
            }
        ],
        "name": "statusForApp",
        "outputs": [
            {
                "internalType": "uint8",
                "name": "",
                "type": "uint8"
            }
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "bytes32",
                "name": "app_id",
                "type": "bytes32"
            },
            {
                "internalType": "address",
                "name": "publisher",
                "type": "address"
            }
        ],
        "name": "suspendForApp",
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
        "name": "withdrawEth",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "anonymous": false,
        "inputs": [
            {
                "indexed": true,
                "internalType": "bytes32",
                "name": "app_id",
                "type": "bytes32"
            },
            {
                "indexed": true,
                "internalType": "address",
                "name": "owner",
                "type": "address"
            }
        ],
        "name": "AppRegistered",
        "type": "event"
    },
    {
        "anonymous": false,
        "inputs": [
            {
                "indexed": true,
                "internalType": "bytes32",
                "name": "app_id",
                "type": "bytes32"
            },
            {
                "indexed": false,
                "internalType": "bytes32",
                "name": "terms_hash",
                "type": "bytes32"
            },
            {
                "indexed": false,
                "internalType": "string",
                "name": "terms_uri",
                "type": "string"
            }
        ],
        "name": "AppTermsChanged",
        "type": "event"
    },
    {
        "anonymous": false,
        "inputs": [
            {
                "indexed": true,
                "internalType": "bytes32",
                "name": "app_id",
                "type": "bytes32"
            },
            {
                "indexed": false,
                "internalType": "uint256",
                "name": "fee",
                "type": "uint256"
            }
        ],
        "name": "AppFeeChanged",
        "type": "event"
    },
    {
        "anonymous": false,
        "inputs": [
            {
                "indexed": true,
                "internalType": "bytes32",
                "name": "app_id",
                "type": "bytes32"
            },
            {
                "indexed": true,
                "internalType": "address",
                "name": "publisher",
                "type": "address"
            },
            {
                "indexed": false,
                "internalType": "bytes32",
                "name": "terms_hash",
                "type": "bytes32"
            },
            {
                "indexed": false,
                "internalType": "uint256",
                "name": "fee",
                "type": "uint256"
            }
        ],
        "name": "PublisherJoined",
        "type": "event"
    },
    {
        "anonymous": false,
        "inputs": [
            {
                "indexed": true,
                "internalType": "bytes32",
                "name": "app_id",
                "type": "bytes32"
            },
            {
                "indexed": true,
                "internalType": "address",
                "name": "publisher",
                "type": "address"
            }
        ],
        "name": "PublisherSuspendedForApp",
        "type": "event"
    },
    {
        "anonymous": false,
        "inputs": [
            {
                "indexed": true,
                "internalType": "bytes32",
                "name": "app_id",
                "type": "bytes32"
            },
            {
                "indexed": true,
                "internalType": "address",
                "name": "publisher",
                "type": "address"
            }
        ],
        "name": "PublisherReinstatedForApp",
        "type": "event"
    },
    {
        "anonymous": false,
        "inputs": [
            {
                "indexed": true,
                "internalType": "bytes32",
                "name": "app_id",
                "type": "bytes32"
            },
            {
                "indexed": false,
                "internalType": "bool",
                "name": "suspended",
                "type": "bool"
            }
        ],
        "name": "AppSuspensionChanged",
        "type": "event"
    }
] as const;
