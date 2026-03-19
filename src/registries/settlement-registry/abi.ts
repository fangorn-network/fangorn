import { parseAbi } from "viem";

export const SETTLEMENT_REGISTRY_ABI = parseAbi([
    "function createResource(bytes32 resource_id, uint256 price) external returns (uint256)",
    "function addSeedMember(bytes32 resource_id) external",
    "function updatePrice(bytes32 resource_id, uint256 price) external",
    "function registerHook(bytes32 resource_id, address hook) external",
    "function register(bytes32 resource_id, uint256 identity_commitment, address from, address to, uint256 amount, uint256 valid_after, uint256 valid_before, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external payable",
    "function settle(bytes32 resource_id, address stealth_address, uint256 merkle_tree_depth, uint256 merkle_tree_root, uint256 nullifier, uint256 message, uint256[8] calldata points, uint8[] memory hook_data) external",
    "function isSettled(address stealth_address, bytes32 resource_id) external view returns (bool)",
    "function getGroupId(bytes32 resource_id) external view returns (uint256)",
    "function getHook(bytes32 resource_id) external view returns (address)",
    "function getOwner(bytes32 resource_id) external view returns (address)",
    "function isRegistered(bytes32 resource_id, uint256 identity_commitment) external view returns (bool)",
    "error AlreadyRegistered()",
    "error AlreadySettled()",
    "error IncorrectPaymentAmount()",
    "error TransferFailed()",
    "error VerificationFailed()",
    "error NotResourceOwner()",
    "error ResourceNotFound()",
    "error HookFailed()",
    "error GroupCreationFailed()"
]);