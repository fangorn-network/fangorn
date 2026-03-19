import { type Hex, type WalletClient } from "viem";
import { SDK } from "agent0-sdk";
import { SchemaRegistry } from "../../registries/schema-registry";
import StorageProvider from "../../providers/storage";
import { RegisterAgentParams, RegisteredAgent, RegisteredSchema, RegisterSchemaParams, SchemaBlobV1, SchemaDefinition, SchemaRoleConfig } from "./types";

export * from './types';

export class SchemaRole {
    private readonly agent0: SDK | null;

    constructor(
        private readonly schemaRegistry: SchemaRegistry,
        private readonly storage: StorageProvider<unknown>,
        private readonly walletClient: WalletClient,
        config?: SchemaRoleConfig,
    ) {
        this.agent0 = config
            ? new SDK({
                chainId: config.chainId,
                rpcUrl: config.rpcUrl,
                privateKey: config.privateKey,
                ipfs: "pinata",
                pinataJwt: config.pinataJwt,
                ...(config.registryOverrides && { registryOverrides: config.registryOverrides }),
                ...(config.subgraphOverrides && { subgraphOverrides: config.subgraphOverrides }),
            })
            : null;
    }
    
    /**
     * Register an agent identity via the agent0-sdk / ERC-8004.
     *
     * Creates the agent, attaches optional A2A card / MCP endpoint / ENS,
     * then pins and registers on-chain. Returns .
     * 
     * @params params
     * @returns the resulting agentId
     */
    async registerAgent(params: RegisterAgentParams): Promise<RegisteredAgent> {
        const sdk = this.requireAgent0();
        const agent = sdk.createAgent(params.name, params.description);

        if (params.a2aUrl) {
            await agent.setA2A(params.a2aUrl);
        }

        if (params.mcpEndpoint) {
            await agent.setMCP(params.mcpEndpoint);
        }

        if (params.ens) {
            agent.setENS(params.ens);
        }

        agent.setActive(true);
        agent.setX402Support(true);

        const regTx = await agent.registerIPFS();
        const { result: registrationFile } = await regTx.waitConfirmed();

        const agentId = registrationFile.agentId;
        if (!agentId) throw new Error("ERC-8004 registration did not return an agentId");

        return { agentId };
    }

    /**
     * Register a schema on-chain, tied to an existing agent identity.
     *
     * Uploads a versioned schema blob to IPFS (definition + metadata), then
     * calls SchemaRegistry.registerSchema(name, schemaCid, agentId).
     * 
     * @returns The registered schema data
     */
    async register(params: RegisterSchemaParams): Promise<RegisteredSchema> {
        const owner = this.requireAccount();

        const blob: SchemaBlobV1 = {
            version: 1,
            name: params.name,
            owner,
            agentId: params.agentId,
            definition: params.definition,
            createdAt: new Date().toISOString(),
        };

        const schemaCid = await this.storage.store(blob, {
            metadata: { name: `schema:${params.name}` },
        });

        const { schemaId } = await this.schemaRegistry.registerSchema(
            params.name,
            schemaCid,
            params.agentId,
        );

        return {
            schemaId,
            schemaCid,
            definition: params.definition,
            name: params.name,
            agentId: params.agentId,
            owner,
        };
    }

    /**
     * Fetch a registered schema by its on-chain schema name.
     * Returns undefined if the schemaId is not registered.
     */
    async get(schemaName: string): Promise<RegisteredSchema | undefined> {
        try {
            const record = await this.schemaRegistry.getSchema(schemaName);
            if (!record.cid) return undefined;

            
            console.log('found ' + JSON.stringify(record))


            const blob = (await this.storage.retrieve(record.cid)) as SchemaBlobV1;

            return {
                schemaId: "0xTODO",
                schemaCid: record.cid,
                definition: blob.definition,
                name: blob.name,
                agentId: blob.agentId,
                owner: blob.owner,
            };
        } catch (e) {
            console.error(e)
            return undefined;
        }
    }

    /**
     * Validate that a data object structurally conforms to a schema definition.
     *
     * Shallow type-level check — catches missing fields and type mismatches
     * before a publisher wastes gas on a bad commit. Encrypted fields require
     * a `handle` object to be present; ciphertext validity is enforced by the
     * encryption service at upload time.
     *
     * Returns a list of validation errors, or an empty array if valid.
     */
    validate(data: Record<string, unknown>, definition: SchemaDefinition): string[] {
        const errors: string[] = [];

        for (const [field, fieldDef] of Object.entries(definition)) {
            const value = data[field];

            if (value === undefined || value === null) {
                errors.push(`Missing required field: "${field}"`);
                continue;
            }

            switch (fieldDef["@type"]) {
                case "string":
                    if (typeof value !== "string")
                        errors.push(`Field "${field}" must be a string, got ${typeof value}`);
                    break;

                case "number":
                    if (typeof value !== "number")
                        errors.push(`Field "${field}" must be a number, got ${typeof value}`);
                    break;

                case "boolean":
                    if (typeof value !== "boolean")
                        errors.push(`Field "${field}" must be a boolean, got ${typeof value}`);
                    break;

                case "bytes":
                    if (!(value instanceof Uint8Array) && !ArrayBuffer.isView(value))
                        errors.push(`Field "${field}" must be bytes (Uint8Array)`);
                    break;

                case "encrypted": {
                    const asObj = value as Record<string, unknown>;
                    if (!asObj.handle || typeof asObj.handle !== "object")
                        errors.push(
                            `Field "${field}" is encrypted — expected a { handle: { cid, gateway } } shape`,
                        );
                    break;
                }
            }
        }

        return errors;
    }

    private requireAccount(): Hex {
        const address = this.walletClient.account?.address;
        if (!address) throw new Error("No account connected to wallet client");
        return address;
    }


    private requireAgent0(): SDK {
        if (!this.agent0) {
            throw new Error(
                "registerAgent() requires AgentConfig (privateKey + pinataJwt). " +
                "Pass agentConfig to Fangorn.init() to enable ERC-8004 registration.",
            );
        }
        return this.agent0;
    }
}