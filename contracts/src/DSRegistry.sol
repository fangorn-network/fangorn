// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.21;

interface IUSDC {
    /**
     * @notice Execute a transfer with a signed authorization
     * @dev EIP-3009: Allows direct A -> B transfers submitted by a 3rd party
     */
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

contract DSRegistry {
    // errors
    error AlreadyPaid();
    error NotOwner();
    error DataSourceNotFound();
    error DataSourceAlreadyExists();

    IUSDC public immutable usdc;

    struct DataSource {
        string name;
        bytes32 poseidonRoot;
        string manifestCid;
        address owner;
    }

    mapping(address => bytes32[]) public owned;
    mapping(bytes32 => DataSource) public dataSources;
    // commitment -> user -> hasPaid
    mapping(bytes32 => mapping(address => bool)) public settlementTracker;

    // Events
    event DataSourceCreated(
        bytes32 indexed id,
        address indexed owner,
        string name
    );

    event DataSourceUpdated(
        bytes32 indexed id,
        bytes32 newRoot,
        string newManifestCid
    );

    event SettlementRecorded(
        bytes32 indexed commitment,
        address indexed user,
        uint256 amount
    );

    // modifiers
    modifier dataSourceExists(bytes32 id) {
        if (dataSources[id].owner == address(0)) revert DataSourceNotFound();
        _;
    }

    modifier onlyDataSourceOwner(bytes32 id) {
        if (dataSources[id].owner != msg.sender) revert NotOwner();
        _;
    }

    constructor(address _usdc) {
        usdc = IUSDC(_usdc);
    }

    /**
     * @notice Settles a payment using an x402/EIP-3009 authorization signature
     * @dev Called by the Facilitator. The user provides the signature off-chain.
     * @param commitment Unique identifier for this payment context
     * @param from The user paying
     * @param value Amount in USDC (6 decimals)
     * @param validAfter Unix timestamp after which the authorization is valid
     * @param validBefore Unix timestamp before which the authorization is valid
     * @param nonce Unique nonce for EIP-3009
     * @param v Signature component
     * @param r Signature component
     * @param s Signature component
     */
    function pay(
        bytes32 commitment,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
    if (settlementTracker[commitment][from]) revert AlreadyPaid();

        // address to = dataSources[dataSourceId].owner;

        usdc.transferWithAuthorization(
            from,
            to,
            value,
            validAfter,
            validBefore,
            nonce,
            v,
            r,
            s
        );

        settlementTracker[commitment][from] = true;
        emit SettlementRecorded(commitment, from, value);
    }

    /**
     * @notice Check if a user has paid for a specific commitment
     * @param commitment The payment commitment
     * @param user The user address
     * @return Whether the user has paid
     */
    function checkSettlement(
        bytes32 commitment,
        address user
    ) external view returns (bool) {
        return settlementTracker[commitment][user];
    }

    /**
     * @notice Register a new data source
     * @param name Human-readable name for the data source
     * @return id The unique identifier for the data source
     */
    function registerDataSource(
        string calldata name
    ) external returns (bytes32 id) {
    id = keccak256(abi.encode(name, msg.sender));
        require(
			dataSources[id].owner == address(0),
			"The data source is already registered"
		);

        dataSources[id] = DataSource({
            name: name,
            poseidonRoot: bytes32(0),
            manifestCid: "",
            owner: msg.sender
        });

        owned[msg.sender].push(id);
        emit DataSourceCreated(id, msg.sender, name);
    }

    /**
     * @notice Update a data source's root and manifest
     * @param id The data source identifier
     * @param newRoot New Poseidon merkle root
     * @param newManifestCid New IPFS CID for the manifest
     */
    function updateDataSource(
        bytes32 id,
        bytes32 newRoot,
        string calldata newManifestCid
    ) external dataSourceExists(id) onlyDataSourceOwner(id) {
        dataSources[id].poseidonRoot = newRoot;
        dataSources[id].manifestCid = newManifestCid;
        emit DataSourceUpdated(id, newRoot, newManifestCid);
    }

    /**
     * @notice Get full details of a data source
     * @param id The data source identifier
     * @return poseidonRoot The merkle root
     * @return manifestCid The IPFS manifest CID
     * @return owner The owner address
     * @return name The human-readable name
     */
    function getDataSource(
        bytes32 id
    )
        external
        view
        dataSourceExists(id)
        returns (
            bytes32 poseidonRoot,
            string memory manifestCid,
            address owner,
            string memory name
        )
    {
        DataSource memory ds = dataSources[id];
        return (ds.poseidonRoot, ds.manifestCid, ds.owner, ds.name);
    }

    /**
     * @notice Get all data source IDs owned by an address
     * @param owner The owner address
     * @return Array of data source IDs
     */
    function getOwnedDataSources(
        address owner
    ) external view returns (bytes32[] memory) {
        return owned[owner];
    }
}
