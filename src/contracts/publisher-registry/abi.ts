export const PUBLISHER_REGISTRY_ABI = [
    {
        "inputs": [],
        "name": "AlreadyRegistered",
        "type": "error"
    },
    {
        "inputs": [],
        "name": "BucketCreationFailed",
        "type": "error"
    },
    {
        "inputs": [],
        "name": "ForwardFailed",
        "type": "error"
    },
    {
        "inputs": [],
        "name": "NotRegistered",
        "type": "error"
    },
    {
        "inputs": [],
        "name": "RegistrationFeeRequired",
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
        "inputs": [
            {
                "internalType": "address",
                "name": "publisher",
                "type": "address"
            }
        ],
        "name": "bucketOf",
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
                "internalType": "string",
                "name": "schema_name",
                "type": "string"
            }
        ],
        "name": "deleteSchema",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "factory",
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
                "name": "publisher",
                "type": "address"
            },
            {
                "internalType": "string",
                "name": "schema_name",
                "type": "string"
            },
            {
                "internalType": "string",
                "name": "name",
                "type": "string"
            }
        ],
        "name": "getBucketManifest",
        "outputs": [
            {
                "internalType": "string",
                "name": "",
                "type": "string"
            },
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
            },
            {
                "internalType": "string",
                "name": "schema_name",
                "type": "string"
            },
            {
                "internalType": "string",
                "name": "name",
                "type": "string"
            }
        ],
        "name": "getBucketMerkleRoot",
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
            },
            {
                "internalType": "string",
                "name": "schema_name",
                "type": "string"
            },
            {
                "internalType": "bytes32",
                "name": "name_hash",
                "type": "bytes32"
            }
        ],
        "name": "getBucketNameByHash",
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
                "internalType": "address",
                "name": "publisher",
                "type": "address"
            },
            {
                "internalType": "bytes32",
                "name": "schema_id",
                "type": "bytes32"
            },
            {
                "internalType": "string",
                "name": "name",
                "type": "string"
            }
        ],
        "name": "getBucketResourceId",
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
            },
            {
                "internalType": "string",
                "name": "schema_name",
                "type": "string"
            }
        ],
        "name": "getBucketSchema",
        "outputs": [
            {
                "internalType": "string",
                "name": "",
                "type": "string"
            },
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
                "internalType": "address",
                "name": "publisher",
                "type": "address"
            },
            {
                "internalType": "bytes32",
                "name": "schema_id",
                "type": "bytes32"
            }
        ],
        "name": "getBucketSchemaExists",
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
                "name": "publisher",
                "type": "address"
            },
            {
                "internalType": "string",
                "name": "schema_name",
                "type": "string"
            },
            {
                "internalType": "string",
                "name": "name",
                "type": "string"
            }
        ],
        "name": "getBucketVersion",
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
        "inputs": [
            {
                "internalType": "address",
                "name": "bucket",
                "type": "address"
            }
        ],
        "name": "ownerOf",
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
                "internalType": "string",
                "name": "manifest_cid",
                "type": "string"
            },
            {
                "internalType": "bytes32",
                "name": "merkle_root",
                "type": "bytes32"
            },
            {
                "internalType": "string",
                "name": "schema_name",
                "type": "string"
            },
            {
                "internalType": "string",
                "name": "name",
                "type": "string"
            }
        ],
        "name": "publish",
        "outputs": [],
        "stateMutability": "nonpayable",
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
        "outputs": [
            {
                "internalType": "address",
                "name": "",
                "type": "address"
            }
        ],
        "stateMutability": "payable",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "string",
                "name": "name",
                "type": "string"
            },
            {
                "internalType": "string",
                "name": "spec_cid",
                "type": "string"
            },
            {
                "internalType": "string",
                "name": "agent_id",
                "type": "string"
            }
        ],
        "name": "registerSchema",
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
                "internalType": "address",
                "name": "factory",
                "type": "address"
            }
        ],
        "name": "setFactory",
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
        "name": "setRegistrationFee",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "string",
                "name": "schema_name",
                "type": "string"
            },
            {
                "internalType": "string",
                "name": "new_agent_id",
                "type": "string"
            }
        ],
        "name": "updateSchemaAgent",
        "outputs": [],
        "stateMutability": "nonpayable",
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
                "indexed": true,
                "internalType": "address",
                "name": "bucket",
                "type": "address"
            }
        ],
        "name": "PublisherRegistered",
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
    }
];