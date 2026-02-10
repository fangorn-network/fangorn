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

	// a data source was created
	event DataSourceCreated(bytes32 indexed id, address indexed owner);

	// a data source was update d
	event DataSourceUpdated(
		bytes32 indexed id,
		bytes32 newRoot,
		string newManifestCid
	);

	// a payment was settled and recorded onchain
	event SettlementRecorded(
		bytes32 indexed commitment,
		address indexed user,
		uint256 amount
	);

	constructor(address _usdc) {
		usdc = IUSDC(_usdc);
	}

	/**
	 * @notice Settles a payment using an x402/EIP-3009 authorization signature
	 * @dev Called by the Facilitator. The user provides the signature off-chain.
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
		require(!settlementTracker[commitment][from], "Already paid");

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

	function checkSettlement(
		bytes32 commitment,
		address user
	) external view returns (bool) {
		return settlementTracker[commitment][user];
	}

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
		emit DataSourceCreated(id, msg.sender);
	}

	function updateVault(
		bytes32 id,
		bytes32 newRoot,
		string calldata newManifestCid
	) external {
		require(dataSources[id].owner == msg.sender, "Not owner");
		dataSources[id].poseidonRoot = newRoot;
		dataSources[id].manifestCid = newManifestCid;
		emit DataSourceUpdated(id, newRoot, newManifestCid);
	}

	function getVault(
		bytes32 id
	)
		external
		view
		returns (
			bytes32 poseidonRoot,
			string memory manifestCid,
			address owner,
			string memory name
		)
	{
		DataSource memory v = dataSources[id];
		return (v.poseidonRoot, v.manifestCid, v.owner, v.name);
	}

	function getOwnedDataSources(
		address owner
	) external view returns (bytes32[] memory) {
		return owned[owner];
	}
}
