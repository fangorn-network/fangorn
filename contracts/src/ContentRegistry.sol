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

contract ContentRegistry {
	IUSDC public immutable usdc;

	struct Vault {
		string name;
		bytes32 poseidonRoot;
		string manifestCid;
		address owner;
	}

	mapping(address => bytes32[]) public ownedVaults;
	mapping(bytes32 => Vault) public vaults;

	// commitment -> user -> hasPaid
	mapping(bytes32 => mapping(address => bool)) public settlementTracker;

	event VaultCreated(bytes32 indexed vaultId, address indexed owner);
	event VaultUpdated(
		bytes32 indexed vaultId,
		bytes32 newRoot,
		string newManifestCid
	);
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

	function createVault(
		string calldata name
	) external returns (bytes32 vaultId) {
		vaultId = keccak256(abi.encode(name, msg.sender));
		require(vaults[vaultId].owner == address(0), "Vault exists");
		vaults[vaultId] = Vault({
			name: name,
			poseidonRoot: bytes32(0),
			manifestCid: "",
			owner: msg.sender
		});
		ownedVaults[msg.sender].push(vaultId);
		emit VaultCreated(vaultId, msg.sender);
	}

	function updateVault(
		bytes32 vaultId,
		bytes32 newRoot,
		string calldata newManifestCid
	) external {
		require(vaults[vaultId].owner == msg.sender, "Not owner");
		vaults[vaultId].poseidonRoot = newRoot;
		vaults[vaultId].manifestCid = newManifestCid;
		emit VaultUpdated(vaultId, newRoot, newManifestCid);
	}

	function getVault(
		bytes32 vaultId
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
		Vault memory v = vaults[vaultId];
		return (v.poseidonRoot, v.manifestCid, v.owner, v.name);
	}

	function getOwnedVault(
		address owner
	) external view returns (bytes32[] memory) {
		return ownedVaults[owner];
	}
}
