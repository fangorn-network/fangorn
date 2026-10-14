export const DATA_REGISTRY_ABI = [
    {
        "inputs": [],
        "name": "NotRegisteredForApp",
        "type": "error"
    },
    {
        "inputs": [],
        "name": "PublisherSuspendedErr",
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
        "name": "appRegistry",
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
        "name": "reinstateGlobal",
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
            },
            {
                "internalType": "bytes32",
                "name": "subspace_id",
                "type": "bytes32"
            },
            {
                "internalType": "bytes32",
                "name": "root",
                "type": "bytes32"
            }
        ],
        "name": "seedNamespaceHead",
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
            }
        ],
        "name": "setAppRegistry",
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
    },
    {
        "inputs": [
            {
                "internalType": "address",
                "name": "",
                "type": "address"
            }
        ],
        "name": "suspended",
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
    }
] as const;
