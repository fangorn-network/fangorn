import { parseAbi } from "viem";

export const SCHEMA_REGISTRY_ABI = parseAbi([
    "function schemaId(string calldata name) external view returns (bytes32)",
    "function registerSchema(string calldata name, string calldata spec_cid, string calldata agent_id) external returns (bytes32)",
    "function updateSchema(bytes32 id, string calldata new_spec_cid, string calldata new_agent_id) external",
    "function getSchemaSpec(bytes32 id) external view returns (string memory)",
    "function getSchemaAgent(bytes32 id) external view returns (string memory)",
    "function schemaExists(bytes32 id) external view returns (bool)",
    "event SchemaRegistered(bytes32 indexed id, address indexed owner, string name, string spec_cid, string agent_id)",
    "event SchemaUpdated(bytes32 indexed id, string new_spec_cid, string new_agent_id)",
    "error NotOwner()",
    "error SchemaNotFound()",
    "error SchemaAlreadyExists()",
]);
