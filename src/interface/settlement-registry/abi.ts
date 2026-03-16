import { parseAbi } from "viem";

export const SETTLEMENT_REGISTRY_ABI = parseAbi([
    "function createResource(bytes32 resource_id) external returns (uint256)",
    "function registerHook(bytes32 resource_id, address hook) external",
    "function register(bytes32 resource_id, uint256 identity_commitment, address from, address to, uint256 amount, uint256 valid_after, uint256 valid_before, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external payable",
    "function settle(bytes32 resource_id, uint256 nullifier_hash, uint256 message, uint256 merkle_root, uint256[8] calldata proof, uint8[] memory hook_data) external",
    "function isSettled(uint256 nullifier_hash) external view returns (bool)",
    "function getGroupId(bytes32 resource_id) external view returns (uint256)",
    "function getHook(bytes32 resource_id) external view returns (address)",
    "function getOwner(bytes32 resource_id) external view returns (address)",
    "function isRegistered(bytes32 resource_id, uint256 identity_commitment) external view returns (bool)",
    "error AlreadyRegistered()",
    "error AlreadySettled()",
    "error TransferFailed()",
    "error VerificationFailed()",
    "error NotResourceOwner()",
    "error ResourceNotFound()",
    "error HookFailed()",
    "error GroupCreationFailed()"
]);