// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.21;

interface IVerifier {
    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external view returns (bool);
}

contract ZKGate {

    struct Vault {
        bytes32 passwordHash;
        bytes32 poseidonRoot;
        string manifestCid;
        address owner;
    }
    
    mapping(bytes32 => Vault) public vaults;
    mapping(bytes32 => bool) public spentNullifiers;
    // vaultId => cidCommitment => user => hasAccess
    mapping(bytes32 => mapping(bytes32 => mapping(address => bool))) public cidAccess;
    
    IVerifier public verifier;
    uint256 public vaultCreationFee;
    address public treasury;
    
    event VaultCreated(bytes32 indexed vaultId, address indexed owner);
    event VaultUpdated(bytes32 indexed vaultId, bytes32 newRoot, string newManifestCid);
    event CIDAccessGranted(bytes32 indexed vaultId, bytes32 indexed cidCommitment, address indexed user);
    
    constructor(address _verifier, address _treasury, uint256 _fee) {
        verifier = IVerifier(_verifier);
        treasury = _treasury;
        vaultCreationFee = _fee;
    }
    
    function createVault(bytes32 passwordHash) external payable returns (bytes32 vaultId) {
        require(msg.value >= vaultCreationFee, "Insufficient fee");
        
        vaultId = keccak256(abi.encode(passwordHash, msg.sender));
        require(vaults[vaultId].owner == address(0), "Vault exists");
        
        vaults[vaultId] = Vault({
            passwordHash: passwordHash,
            poseidonRoot: bytes32(0),
            manifestCid: "",
            owner: msg.sender
        });
        
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
    
    function submitProof(
        bytes32 vaultId,
        bytes32 cidCommitment,
        bytes32 nullifier,
        bytes calldata proof
    ) external {
        require(!spentNullifiers[nullifier], "Nullifier spent");
        
        Vault memory vault = vaults[vaultId];
        require(vault.owner != address(0), "Vault not found");
        require(vault.poseidonRoot != bytes32(0), "Empty vault");
        
        bytes32[] memory publicInputs = buildPublicInputs(
            vault.passwordHash,
            vault.poseidonRoot,
            msg.sender,
            vaultId,
            nullifier,
            cidCommitment
        );
        
        require(verifier.verify(proof, publicInputs), "Invalid proof");
        
        spentNullifiers[nullifier] = true;
        cidAccess[vaultId][cidCommitment][msg.sender] = true;
        
        emit CIDAccessGranted(vaultId, cidCommitment, msg.sender);
    }
    
    function buildPublicInputs(
        bytes32 passwordHash,
        bytes32 poseidonRoot,
        address user,
        bytes32 vaultId,
        bytes32 nullifier,
        bytes32 cidCommitment
    ) internal pure returns (bytes32[] memory) {
        // Circuit public input order:
        // expected_hash: [u8; 32] = 32 fields
        // merkle_root: Field = 1 field
        // user_address: [u8; 32] = 32 fields
        // vault_id: [u8; 32] = 32 fields
        // nullifier: [u8; 32] = 32 fields
        // cid_commitment: Field = 1 field
        // Total: 130 fields
        
        bytes32[] memory inputs = new bytes32[](130);
        uint256 idx = 0;
        
        // expected_hash (32 bytes)
        for (uint256 i = 0; i < 32; i++) {
            inputs[idx++] = bytes32(uint256(uint8(passwordHash[i])));
        }
        
        // merkle_root (1 Field)
        inputs[idx++] = poseidonRoot;
        
        // user_address (32 bytes, left-padded)
        bytes32 userBytes = bytes32(uint256(uint160(user)));
        for (uint256 i = 0; i < 32; i++) {
            inputs[idx++] = bytes32(uint256(uint8(userBytes[i])));
        }
        
        // vault_id (32 bytes)
        for (uint256 i = 0; i < 32; i++) {
            inputs[idx++] = bytes32(uint256(uint8(vaultId[i])));
        }
        
        // nullifier (32 bytes)
        for (uint256 i = 0; i < 32; i++) {
            inputs[idx++] = bytes32(uint256(uint8(nullifier[i])));
        }
        
        // cid_commitment (1 Field)
        inputs[idx++] = cidCommitment;
        
        return inputs;
    }
    

	// READ FUNCS

    function checkCIDAccess(
        bytes32 vaultId,
        bytes32 cidCommitment,
        address user
    ) external view returns (bool) {
        return cidAccess[vaultId][cidCommitment][user];
    }
    
    function getVault(bytes32 vaultId) external view returns (
        bytes32 passwordHash,
        bytes32 poseidonRoot,
        string memory manifestCid,
        address owner
    ) {
        Vault memory v = vaults[vaultId];
        return (v.passwordHash, v.poseidonRoot, v.manifestCid, v.owner);
    }
}