// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.21;

import { IVerifier, ZKGate } from "../src/ZKGate.sol";
import {Test, console} from "forge-std/Test.sol";

/// @notice Mock verifier that can be configured to pass or fail
contract MockVerifier is IVerifier {
    bool public shouldPass;
    bytes32[] public lastPublicInputs;
    bytes public lastProof;

    constructor(bool _shouldPass) {
        shouldPass = _shouldPass;
    }

    function setShouldPass(bool _shouldPass) external {
        shouldPass = _shouldPass;
    }

    function verify(
        bytes calldata proof,
        bytes32[] calldata publicInputs
    ) external view override returns (bool) {
        return shouldPass;
    }
}

contract ZKGateTest is Test {
    ZKGate public zkGate;
    MockVerifier public mockVerifier;

    address public treasury = address(0xBEEF);
    address public alice = address(0xA11CE);
    address public bob = address(0xB0B);

    uint256 public constant VAULT_FEE = 0.01 ether;

    bytes32 public constant TEST_PASSWORD_HASH = keccak256("secret123");
    bytes32 public constant TEST_POSEIDON_ROOT = keccak256("merkle_root");
    bytes32 public constant TEST_CID_COMMITMENT = keccak256("cid_commitment");
    bytes32 public constant TEST_NULLIFIER = keccak256("nullifier_1");
    string public constant TEST_MANIFEST_CID = "QmTestCID123";
    string public constant TEST_VAULT_NAME = "My Secret Vault";

    event VaultCreated(bytes32 indexed vaultId, address indexed owner);
    event VaultUpdated(bytes32 indexed vaultId, bytes32 newRoot, string newManifestCid);
    event CIDAccessGranted(bytes32 indexed vaultId, bytes32 indexed cidCommitment, address indexed user);

    function setUp() public {
        mockVerifier = new MockVerifier(true);
        zkGate = new ZKGate(address(mockVerifier), treasury, VAULT_FEE);

        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
    }

    // ============ Constructor Tests ============

    function test_Constructor() public view {
        assertEq(address(zkGate.verifier()), address(mockVerifier));
        assertEq(zkGate.treasury(), treasury);
        assertEq(zkGate.vaultCreationFee(), VAULT_FEE);
    }

    // ============ createVault Tests ============

    function test_CreateVault_Success() public {
        vm.startPrank(alice);

        bytes32 expectedVaultId = keccak256(abi.encode(TEST_PASSWORD_HASH, alice));

        vm.expectEmit(true, true, false, false);
        emit VaultCreated(expectedVaultId, alice);

        bytes32 vaultId = zkGate.createVault{value: VAULT_FEE}(
            TEST_VAULT_NAME,
            TEST_PASSWORD_HASH
        );

        assertEq(vaultId, expectedVaultId);

        (bytes32 passwordHash, bytes32 poseidonRoot, string memory manifestCid, address owner) =
            zkGate.getVault(vaultId);

        assertEq(passwordHash, TEST_PASSWORD_HASH);
        assertEq(poseidonRoot, bytes32(0));
        assertEq(manifestCid, "");
        assertEq(owner, alice);

        bytes32[] memory ownedVaults = zkGate.getOwnedVault(alice);
        assertEq(ownedVaults.length, 1);
        assertEq(ownedVaults[0], vaultId);

        vm.stopPrank();
    }

    function test_CreateVault_WithExcessFee() public {
        vm.prank(alice);
        bytes32 vaultId = zkGate.createVault{value: 1 ether}(
            TEST_VAULT_NAME,
            TEST_PASSWORD_HASH
        );

        (, , , address owner) = zkGate.getVault(vaultId);
        assertEq(owner, alice);
    }

    function test_CreateVault_RevertInsufficientFee() public {
        vm.prank(alice);
        vm.expectRevert("Insufficient fee");
        zkGate.createVault{value: VAULT_FEE - 1}(TEST_VAULT_NAME, TEST_PASSWORD_HASH);
    }

    function test_CreateVault_RevertZeroFee() public {
        vm.prank(alice);
        vm.expectRevert("Insufficient fee");
        zkGate.createVault{value: 0}(TEST_VAULT_NAME, TEST_PASSWORD_HASH);
    }

    function test_CreateVault_RevertDuplicateVault() public {
        vm.startPrank(alice);

        zkGate.createVault{value: VAULT_FEE}(TEST_VAULT_NAME, TEST_PASSWORD_HASH);

        vm.expectRevert("Vault exists");
        zkGate.createVault{value: VAULT_FEE}(TEST_VAULT_NAME, TEST_PASSWORD_HASH);

        vm.stopPrank();
    }

    function test_CreateVault_DifferentUsersCanUseSamePasswordHash() public {
        vm.prank(alice);
        bytes32 aliceVaultId = zkGate.createVault{value: VAULT_FEE}(
            TEST_VAULT_NAME,
            TEST_PASSWORD_HASH
        );

        vm.prank(bob);
        bytes32 bobVaultId = zkGate.createVault{value: VAULT_FEE}(
            TEST_VAULT_NAME,
            TEST_PASSWORD_HASH
        );

        assertTrue(aliceVaultId != bobVaultId);
    }

    function test_CreateVault_MultipleVaultsPerUser() public {
        vm.startPrank(alice);

        bytes32 passwordHash1 = keccak256("password1");
        bytes32 passwordHash2 = keccak256("password2");
        bytes32 passwordHash3 = keccak256("password3");

        zkGate.createVault{value: VAULT_FEE}("Vault 1", passwordHash1);
        zkGate.createVault{value: VAULT_FEE}("Vault 2", passwordHash2);
        zkGate.createVault{value: VAULT_FEE}("Vault 3", passwordHash3);

        bytes32[] memory ownedVaults = zkGate.getOwnedVault(alice);
        assertEq(ownedVaults.length, 3);

        vm.stopPrank();
    }

    // ============ updateVault Tests ============

    function test_UpdateVault_Success() public {
        vm.startPrank(alice);

        bytes32 vaultId = zkGate.createVault{value: VAULT_FEE}(
            TEST_VAULT_NAME,
            TEST_PASSWORD_HASH
        );

        vm.expectEmit(true, false, false, true);
        emit VaultUpdated(vaultId, TEST_POSEIDON_ROOT, TEST_MANIFEST_CID);

        zkGate.updateVault(vaultId, TEST_POSEIDON_ROOT, TEST_MANIFEST_CID);

        (, bytes32 poseidonRoot, string memory manifestCid, ) = zkGate.getVault(vaultId);

        assertEq(poseidonRoot, TEST_POSEIDON_ROOT);
        assertEq(manifestCid, TEST_MANIFEST_CID);

        vm.stopPrank();
    }

    function test_UpdateVault_MultipleUpdates() public {
        vm.startPrank(alice);

        bytes32 vaultId = zkGate.createVault{value: VAULT_FEE}(
            TEST_VAULT_NAME,
            TEST_PASSWORD_HASH
        );

        bytes32 root1 = keccak256("root1");
        bytes32 root2 = keccak256("root2");

        zkGate.updateVault(vaultId, root1, "CID1");
        zkGate.updateVault(vaultId, root2, "CID2");

        (, bytes32 poseidonRoot, string memory manifestCid, ) = zkGate.getVault(vaultId);

        assertEq(poseidonRoot, root2);
        assertEq(manifestCid, "CID2");

        vm.stopPrank();
    }

    function test_UpdateVault_RevertNotOwner() public {
        vm.prank(alice);
        bytes32 vaultId = zkGate.createVault{value: VAULT_FEE}(
            TEST_VAULT_NAME,
            TEST_PASSWORD_HASH
        );

        vm.prank(bob);
        vm.expectRevert("Not owner");
        zkGate.updateVault(vaultId, TEST_POSEIDON_ROOT, TEST_MANIFEST_CID);
    }

    function test_UpdateVault_RevertNonExistentVault() public {
        bytes32 fakeVaultId = keccak256("fake_vault");

        vm.prank(alice);
        vm.expectRevert("Not owner");
        zkGate.updateVault(fakeVaultId, TEST_POSEIDON_ROOT, TEST_MANIFEST_CID);
    }

    // ============ submitProof Tests ============

    function test_SubmitProof_Success() public {
        // Setup vault
        vm.startPrank(alice);
        bytes32 vaultId = zkGate.createVault{value: VAULT_FEE}(
            TEST_VAULT_NAME,
            TEST_PASSWORD_HASH
        );
        zkGate.updateVault(vaultId, TEST_POSEIDON_ROOT, TEST_MANIFEST_CID);
        vm.stopPrank();

        // Submit proof as bob
        vm.startPrank(bob);

        bytes memory dummyProof = hex"deadbeef";

        vm.expectEmit(true, true, true, false);
        emit CIDAccessGranted(vaultId, TEST_CID_COMMITMENT, bob);

        zkGate.submitProof(vaultId, TEST_CID_COMMITMENT, TEST_NULLIFIER, dummyProof);

        assertTrue(zkGate.checkCIDAccess(vaultId, TEST_CID_COMMITMENT, bob));
        assertTrue(zkGate.spentNullifiers(TEST_NULLIFIER));

        vm.stopPrank();
    }

    function test_SubmitProof_RevertNullifierSpent() public {
        // Setup vault
        vm.startPrank(alice);
        bytes32 vaultId = zkGate.createVault{value: VAULT_FEE}(
            TEST_VAULT_NAME,
            TEST_PASSWORD_HASH
        );
        zkGate.updateVault(vaultId, TEST_POSEIDON_ROOT, TEST_MANIFEST_CID);
        vm.stopPrank();

        bytes memory dummyProof = hex"deadbeef";

        // First submission
        vm.prank(bob);
        zkGate.submitProof(vaultId, TEST_CID_COMMITMENT, TEST_NULLIFIER, dummyProof);

        // Second submission with same nullifier should fail
        vm.prank(bob);
        vm.expectRevert("Nullifier spent");
        zkGate.submitProof(vaultId, TEST_CID_COMMITMENT, TEST_NULLIFIER, dummyProof);
    }

    function test_SubmitProof_RevertVaultNotFound() public {
        bytes32 fakeVaultId = keccak256("nonexistent");
        bytes memory dummyProof = hex"deadbeef";

        vm.prank(bob);
        vm.expectRevert("Vault not found");
        zkGate.submitProof(fakeVaultId, TEST_CID_COMMITMENT, TEST_NULLIFIER, dummyProof);
    }

    function test_SubmitProof_RevertEmptyVault() public {
        // Create vault but don't update it (no poseidonRoot)
        vm.prank(alice);
        bytes32 vaultId = zkGate.createVault{value: VAULT_FEE}(
            TEST_VAULT_NAME,
            TEST_PASSWORD_HASH
        );

        bytes memory dummyProof = hex"deadbeef";

        vm.prank(bob);
        vm.expectRevert("Empty vault");
        zkGate.submitProof(vaultId, TEST_CID_COMMITMENT, TEST_NULLIFIER, dummyProof);
    }

    function test_SubmitProof_RevertInvalidProof() public {
        // Setup vault
        vm.startPrank(alice);
        bytes32 vaultId = zkGate.createVault{value: VAULT_FEE}(
            TEST_VAULT_NAME,
            TEST_PASSWORD_HASH
        );
        zkGate.updateVault(vaultId, TEST_POSEIDON_ROOT, TEST_MANIFEST_CID);
        vm.stopPrank();

        // Set verifier to reject
        mockVerifier.setShouldPass(false);

        bytes memory dummyProof = hex"deadbeef";

        vm.prank(bob);
        vm.expectRevert("Invalid proof");
        zkGate.submitProof(vaultId, TEST_CID_COMMITMENT, TEST_NULLIFIER, dummyProof);
    }

    function test_SubmitProof_DifferentNullifiersWork() public {
        // Setup vault
        vm.startPrank(alice);
        bytes32 vaultId = zkGate.createVault{value: VAULT_FEE}(
            TEST_VAULT_NAME,
            TEST_PASSWORD_HASH
        );
        zkGate.updateVault(vaultId, TEST_POSEIDON_ROOT, TEST_MANIFEST_CID);
        vm.stopPrank();

        bytes memory dummyProof = hex"deadbeef";
        bytes32 nullifier1 = keccak256("nullifier1");
        bytes32 nullifier2 = keccak256("nullifier2");

        vm.prank(bob);
        zkGate.submitProof(vaultId, TEST_CID_COMMITMENT, nullifier1, dummyProof);

        vm.prank(bob);
        zkGate.submitProof(vaultId, TEST_CID_COMMITMENT, nullifier2, dummyProof);

        assertTrue(zkGate.spentNullifiers(nullifier1));
        assertTrue(zkGate.spentNullifiers(nullifier2));
    }

    // ============ Read Function Tests ============

    function test_CheckCIDAccess_NoAccess() public view {
        bytes32 fakeVaultId = keccak256("fake");
        assertFalse(zkGate.checkCIDAccess(fakeVaultId, TEST_CID_COMMITMENT, alice));
    }

    function test_GetVault_NonExistent() public view {
        bytes32 fakeVaultId = keccak256("nonexistent");
        (bytes32 passwordHash, bytes32 poseidonRoot, string memory manifestCid, address owner) =
            zkGate.getVault(fakeVaultId);

        assertEq(passwordHash, bytes32(0));
        assertEq(poseidonRoot, bytes32(0));
        assertEq(manifestCid, "");
        assertEq(owner, address(0));
    }

    function test_GetOwnedVault_NoVaults() public view {
        bytes32[] memory vaults = zkGate.getOwnedVault(alice);
        assertEq(vaults.length, 0);
    }

    // ============ Fuzz Tests ============

    function testFuzz_CreateVault(
        string calldata name,
        bytes32 passwordHash,
        uint256 fee
    ) public {
        // Bound fee between VAULT_FEE and alice's balance
        fee = bound(fee, VAULT_FEE, 10 ether);

        vm.prank(alice);
        bytes32 vaultId = zkGate.createVault{value: fee}(name, passwordHash);

        (, , , address owner) = zkGate.getVault(vaultId);
        assertEq(owner, alice);
    }

    function testFuzz_VaultIdUniqueness(
        bytes32 passwordHash1,
        bytes32 passwordHash2,
        address user1,
        address user2
    ) public {
        vm.assume(user1 != address(0) && user2 != address(0));
        vm.assume(passwordHash1 != passwordHash2 || user1 != user2);

        bytes32 vaultId1 = keccak256(abi.encode(passwordHash1, user1));
        bytes32 vaultId2 = keccak256(abi.encode(passwordHash2, user2));

        if (passwordHash1 == passwordHash2 && user1 == user2) {
            assertEq(vaultId1, vaultId2);
        } else {
            assertTrue(vaultId1 != vaultId2);
        }
    }

    // ============ Edge Cases ============

    function test_EmptyStringVaultName() public {
        vm.prank(alice);
        bytes32 vaultId = zkGate.createVault{value: VAULT_FEE}("", TEST_PASSWORD_HASH);

        (, , , address owner) = zkGate.getVault(vaultId);
        assertEq(owner, alice);
    }

    function test_ZeroFeeContract() public {
        ZKGate zeroFeeGate = new ZKGate(address(mockVerifier), treasury, 0);

        vm.prank(alice);
        bytes32 vaultId = zeroFeeGate.createVault{value: 0}(
            TEST_VAULT_NAME,
            TEST_PASSWORD_HASH
        );

        (, , , address owner) = zeroFeeGate.getVault(vaultId);
        assertEq(owner, alice);
    }

    function test_LargeManifestCid() public {
        vm.startPrank(alice);

        bytes32 vaultId = zkGate.createVault{value: VAULT_FEE}(
            TEST_VAULT_NAME,
            TEST_PASSWORD_HASH
        );

        // Create a very long CID string
        string memory longCid = "QmYwAPJzv5CZsnANV3FWUHx7kxyaGfXS5RbP8KYnLq1w9bQmYwAPJzv5CZsnANV3FWUHx7kxyaGfXS5RbP8KYnLq1w9b";

        zkGate.updateVault(vaultId, TEST_POSEIDON_ROOT, longCid);

        (, , string memory manifestCid, ) = zkGate.getVault(vaultId);
        assertEq(manifestCid, longCid);

        vm.stopPrank();
    }
}
