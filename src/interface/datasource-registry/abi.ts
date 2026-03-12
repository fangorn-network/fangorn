// abi.ts
import { parseAbi } from "viem";

export const DS_REGISTRY_ABI = parseAbi([
	"function initialize(address schema_registry) external",
	"function publishManifest(string calldata manifest_cid, bytes32 schema_id) external",
	"function getManifest(address owner) external view returns (string memory)",
	"function getVersion(address owner) external view returns (uint64)",
	"function getSchemaId(address owner) external view returns (bytes32)",
	"event ManifestPublished(address indexed owner, string manifest_cid, uint64 version, bytes32 indexed schema_id)",
	"error DataSourceNotFound()",
	"error SchemaNotFound()",
]);
