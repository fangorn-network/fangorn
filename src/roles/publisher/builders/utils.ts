import type { FieldDefinition, SchemaDefinition } from "../../schema/types";
import type {
    FieldInput,
    HandleFieldInput,
    PublishRecord,
    ResolvedField,
    ResolvedHandleField,
} from "../types";

export function isHandleFieldInput(value: FieldInput | undefined): value is HandleFieldInput {
    return (
        typeof value === "object" &&
        value !== null &&
        "@type" in value &&
        (value as { "@type"?: unknown })["@type"] === "handle"
    );
}

export function resolveRecord(
    record: PublishRecord,
    schema: SchemaDefinition,
): { name: string; fields: Record<string, ResolvedField> } {
    const resolved: Record<string, ResolvedField> = {};
    for (const [fieldName] of Object.entries(schema)) {
        const value = record.fields[fieldName];
        if (isHandleFieldInput(value)) {
            resolved[fieldName] = {
                "@type": "handle",
                uri: value.uri,
                workerUrl: value.workerUrl,
            } satisfies ResolvedHandleField;
        } else {
            resolved[fieldName] = value as ResolvedField;
        }
    }
    return { name: record.name, fields: resolved };
}

export function validateRecord(record: PublishRecord, schema: SchemaDefinition): void {
    const errors: string[] = [];
    for (const [fieldName, fieldDef] of Object.entries(schema)) {
        validateField(fieldName, fieldDef, record.fields[fieldName], errors);
    }
    if (errors.length > 0) {
        throw new Error(`Validation failed for "${record.name}":\n` + errors.map(e => ` - ${e}`).join("\n"));
    }
}

function validateField(fieldName: string, fieldDef: FieldDefinition, value: FieldInput | undefined, errors: string[]): void {
    if (isHandleFieldInput(value)) return;
    const rawType = fieldDef["@type"];
    const nullable = rawType.includes("| null");
    const baseType = rawType.replace("| null", "").trim();

    if (value === null || value === undefined) {
        if (!nullable) errors.push(`"${fieldName}" is required`);
        return;
    }

    switch (baseType) {
        case "string":  if (typeof value !== "string")  errors.push(`${fieldName} must be string`);  break;
        case "number":  if (typeof value !== "number")  errors.push(`${fieldName} must be number`);  break;
        case "boolean": if (typeof value !== "boolean") errors.push(`${fieldName} must be boolean`); break;
        case "bytes":   if (!((value as unknown) instanceof Uint8Array)) errors.push(`${fieldName} must be bytes`); break;
    }
}
