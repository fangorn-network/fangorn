import type { SchemaDoc } from "../../schema/types";
import { validate } from "../../schema/validate";
import type {
    FieldInput,
    HandleFieldInput,
    ManifestEntry,
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

export function resolveRecord(record: PublishRecord, schema: SchemaDoc): ManifestEntry  {
    const resolved: Record<string, ResolvedField> = {};
    for (const [fieldName] of Object.entries(schema.fields)) {
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

export function validateRecord(record: PublishRecord, schema: SchemaDoc): void {
    const errors = validate(record.fields as Record<string, unknown>, schema);
    if (errors.length > 0) {
        throw new Error(`Validation failed for "${record.name}":\n` + errors.map(e => ` - ${e}`).join("\n"));
    }
}
