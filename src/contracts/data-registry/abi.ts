// Functions mirror `cargo stylus export-abi` for contracts/data_registry.
// Events are hand-maintained: export-abi does not emit `sol!` event declarations.
export const DATA_REGISTRY_ABI = [
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
        "name": "RegistrationFeeRequired",
        "type": "error"
    },
    {
        "inputs": [],
        "name": "StaleStateRoot",
        "type": "error"
    },
    {
        "inputs": [],
        "name": "Unauthorized",
        "type": "error"
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
                "internalType": "address",
                "name": "publisher",
                "type": "address"
            },
            {
                "indexed": false,
                "internalType": "bytes32",
                "name": "initial_root",
                "type": "bytes32"
            }
        ],
        "name": "PublisherRegistered",
        "type": "event"
    },
    {
        "anonymous": false,
        "inputs": [
            {
                "indexed": true,
                "internalType": "address",
                "name": "publisher",
                "type": "address"
            },
            {
                "indexed": false,
                "internalType": "bytes32",
                "name": "current_root",
                "type": "bytes32"
            }
        ],
        "name": "PublisherReactivated",
        "type": "event"
    },
    {
        "anonymous": false,
        "inputs": [
            {
                "indexed": true,
                "internalType": "address",
                "name": "publisher",
                "type": "address"
            }
        ],
        "name": "PublisherSuspended",
        "type": "event"
    },
    {
        "anonymous": false,
        "inputs": [
            {
                "indexed": false,
                "internalType": "uint256",
                "name": "fee",
                "type": "uint256"
            }
        ],
        "name": "RegistrationFeeChanged",
        "type": "event"
    },
    {
        // Three indexed topics (the max) chosen so every subscription shape the
        // SDK needs is one node-side filter: `namespace_key` = one subspace,
        // `app_id` = a whole app across publishers, `app_id` + `publisher` = one
        // publisher within an app.
        "anonymous": false,
        "inputs": [
            {
                "indexed": true,
                "internalType": "bytes32",
                "name": "namespace_key",
                "type": "bytes32"
            },
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
                "name": "subspace_id",
                "type": "bytes32"
            },
            {
                "indexed": false,
                "internalType": "bytes32",
                "name": "old_root",
                "type": "bytes32"
            },
            {
                "indexed": false,
                "internalType": "bytes32",
                "name": "new_root",
                "type": "bytes32"
            }
        ],
        "name": "StateCommitted",
        "type": "event"
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
            },
            {
                "internalType": "bytes32",
                "name": "subspace_id",
                "type": "bytes32"
            },
            {
                "internalType": "bytes32",
                "name": "old_root",
                "type": "bytes32"
            },
            {
                "internalType": "bytes32",
                "name": "new_root",
                "type": "bytes32"
            }
        ],
        "name": "commitStateRoot",
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
            },
            {
                "internalType": "address",
                "name": "publisher",
                "type": "address"
            },
            {
                "internalType": "bytes32",
                "name": "subspace_id",
                "type": "bytes32"
            }
        ],
        "name": "getNamespaceHead",
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
                "name": "publisher",
                "type": "address"
            }
        ],
        "name": "getPublisherStatus",
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
                "internalType": "address",
                "name": "publisher",
                "type": "address"
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
        "inputs": [],
        "name": "publisherCount",
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
        "name": "register",
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
            }
        ],
        "name": "registerApp",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "registrationFee",
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
                "internalType": "uint256",
                "name": "fee",
                "type": "uint256"
            }
        ],
        "name": "setRegistrationFee",
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
        "name": "suspendPublisher",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    }
] as const;
