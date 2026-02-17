// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.21;

contract DSRegistry {
    // errors
    
    error NotOwner();
    error DataSourceNotFound();
    error DataSourceAlreadyExists();

    struct DataSource {
        string name;
        string manifestCid;
        address owner;
    }

    mapping(address => bytes32[]) public owned;
    mapping(bytes32 => DataSource) public dataSources;

    // Events
    event DataSourceCreated(
        bytes32 indexed id,
        address indexed owner,
        string name
    );

    event DataSourceUpdated(
        bytes32 indexed id,
        string newManifestCid
    );

    event SettlementRecorded(
        bytes32 indexed commitment,
        address indexed user,
        uint256 amount
    );

    constructor() { }

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
            manifestCid: "",
            owner: msg.sender
        });

        owned[msg.sender].push(id);
        emit DataSourceCreated(id, msg.sender, name);
        return id;
    }

    /**
     * @notice Update a data source's root and manifest
     * @param name The data source name
     * @param newManifestCid New IPFS CID for the manifest
     */
    function updateDataSource(
        string calldata name,
        string calldata newManifestCid
    ) external {
        bytes32 id = keccak256(abi.encode(name, msg.sender));
        // existence
        dataSourceExists(id);
        // ownership
        onlyDataSourceOwner(id);

        dataSources[id].manifestCid = newManifestCid;
        emit DataSourceUpdated(id, newManifestCid);
    }

    /**
     * @notice Get full details of a data source
     * @param owner The data source owner
     * @param name The data source name
     * @return manifestCid The IPFS manifest CID
     */
    function getDataSource(
        address owner,
        string calldata name
    )
        external
        view
        returns (
            string memory manifestCid
        )
    {
        bytes32 id = keccak256(abi.encode(name, owner));
        dataSourceExists(id);
        DataSource memory ds = dataSources[id];
        return ds.manifestCid;
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

    // helpers
    function dataSourceExists(bytes32 id) internal view {
        if (dataSources[id].owner == address(0)) revert DataSourceNotFound();
    }

    function onlyDataSourceOwner(bytes32 id) internal view {
        if (dataSources[id].owner != msg.sender) revert NotOwner();
    }
}
