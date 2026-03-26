import { type Hex } from "viem";

// Represents a plaintext field in a schema
export interface PlainField {
    "@type": "string" | "number" | "boolean" | "bytes";
}

// Represents an encrypted field in a schema
export interface EncryptedField {
    "@type": "encrypted";
    /** Gadget identifier — resolved against the GadgetRegistry at publish time */
    gadget: string;
    /** Populated by a publisher after encryption, not defined by the schema owner */
    handle?: {
        cid: string;
        gateway: string;
    };
}

// export type SchemaOrgField = {
// 	"@type": "schemaOrg";
// 	/** e.g. "https://schema.org/Event" */
// 	ref: string;
// };

export type FieldDefinition = PlainField | EncryptedField;

export type SchemaDefinition = Record<string, FieldDefinition>;

// Params for regsitering an agent (using agent0)
export interface RegisterAgentParams {
    name: string;
    description: string;
    /** Optional A2A agent card URL e.g. https://example.com/.well-known/agentcard.json */
    a2aUrl?: string;
    /** Optional MCP endpoint URL */
    mcpEndpoint?: string;
    /** Optional ENS name */
    ens?: string;
}

export interface RegisterSchemaParams {
    definition: SchemaDefinition;
    agentId: string;
    name: string;
}

export interface RegisteredAgent {
    agentId: string;
}

export interface RegisteredSchema {
    schemaId: Hex;
    schemaCid: string;
    definition: SchemaDefinition;
    name: string;
    agentId: string;
    owner: Hex;
}

export interface SchemaBlobV1 {
    version: 1;
    name: string;
    owner: Hex;
    agentId: string;
    definition: SchemaDefinition;
    createdAt: string;
}

export interface SchemaRoleConfig {
    chainId: number;
    rpcUrl: string;
    privateKey: Hex;
    pinataJwt: string;
    /** Optional — override ERC-8004 registry addresses per chainId */
    registryOverrides?: Record<number, { IDENTITY: string; REPUTATION: string }>;
    /** Optional — override subgraph URLs per chainId */
    subgraphOverrides?: Record<number, string>;
}