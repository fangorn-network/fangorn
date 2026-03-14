// abi.ts
import { parseAbi } from "viem";

export const SCHEMA_REGISTRY_ABI = parseAbi([
    "function registerSchema(string calldata name, string calldata spec_cid, string calldata agent_id) external returns (bytes32)",
    "function updateSchema(string calldata name, string calldata new_spec_cid, string calldata new_agent_id) external",
    "function getSchemaSpec(string calldata name) external view returns (string memory)",
    "function getSchemaAgent(string calldata name) external view returns (string memory)",
    "function schemaExists(bytes32 id) external view returns (bool)",
    "event SchemaRegistered(bytes32 indexed id, address indexed owner, string name, string spec_cid, string agent_id)",
    "event SchemaUpdated(bytes32 indexed id, string new_spec_cid, string new_agent_id)",
    "error NotOwner()",
    "error SchemaNotFound()",
    "error SchemaAlreadyExists()",
]);