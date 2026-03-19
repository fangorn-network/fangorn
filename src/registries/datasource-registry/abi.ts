// abi.ts
import { parseAbi } from "viem";

export const DS_REGISTRY_ABI = parseAbi([
    "function initialize(address schema_registry) external",
    "function publishManifest(string calldata manifest_cid, bytes32 schema_id) external",
    "function getManifest(address owner, bytes32 schema_id) external view returns (string memory)",
    "function getVersion(address owner, bytes32 schema_id) external view returns (uint64)",
    "event ManifestPublished(address indexed owner, bytes32 indexed schema_id, string manifest_cid, uint64 version)",
    "error DataSourceNotFound()",
    "error SchemaNotFound()",
    "error SchemaRequired()",
]);