import { type Hex, type WalletClient } from "viem";
import { SchemaRegistry } from "../../registries/schema-registry";
import { MetadataStorage } from "../../providers/storage/types.js"; import { PlainField, RegisteredSchema, RegisterSchemaParams, SchemaBlobV1, SchemaDefinition } from "./types";

export * from './types';

export class SchemaRole {

    constructor(
        private readonly schemaRegistry: SchemaRegistry,
        private readonly storage: MetadataStorage,
        private readonly walletClient: WalletClient,
    ) { }

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

        const schemaCid = await this.storage.put(blob, { name: `schema:${params.name}` });

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

    async get(nameOrId: string): Promise<RegisteredSchema | undefined> {
        try {
            const schemaId = await this.schemaRegistry.schemaId(
                typeof nameOrId === "string" && !/^0x[0-9a-fA-F]{64}$/.test(nameOrId)
                    ? nameOrId
                    : nameOrId as Hex
            );

            const record = await this.schemaRegistry.getSchema(nameOrId);
            if (!record.specCid) return undefined;

            const blob = await this.storage.get<SchemaBlobV1>(record.specCid);

            return {
                schemaId,
                schemaCid: record.specCid,
                definition: blob.definition,
                name: blob.name,
                agentId: blob.agentId,
                owner: blob.owner,
            };
        } catch (e) {
            console.error(e);
            return undefined;
        }
    }

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
                case "handle": {
                    const asObj = value as Record<string, unknown>;
                    if (typeof asObj.uri !== "string")
                        errors.push(`Field "${field}" is a handle — expected { uri: string }`);
                    break;
                }
                case "array": {
                    if (!Array.isArray(value)) {
                        errors.push(`Field "${field}" must be an array, got ${typeof value}`);
                        break;
                    }
                    const items: PlainField = fieldDef.items as PlainField;
                    value.forEach((item: unknown, i) =>
                        errors.push(
                            ...this.validate(
                                { [`${field}[${i.toString()}]`]: item },
                                { [`${field}[${i.toString()}]`]: items },
                            ),
                        ),
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
}