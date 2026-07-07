//
// Copyright (c) Fangorn LLC and contributors. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.
//

import type {
    Constraint,
    FieldDefinition,
    SchemaDefinition,
    SchemaDoc,
    TypeDefinition,
} from "./types";

// Recognized built-in @type values. Anything else is looked up as a custom
// type in SchemaDoc.types. The `| null` suffix is stripped before this check.
const BUILT_INS = new Set([
    "string", "number", "boolean", "bytes", "handle", "array", "object", "encrypted",
]);

/** Accept either the explicit document shape or a bare flat field map. */
export function normalize(schema: SchemaDoc | SchemaDefinition): SchemaDoc {
    if ("fields" in schema && typeof (schema as SchemaDoc).fields === "object") {
        return schema as SchemaDoc;
    }
    return { fields: schema as SchemaDefinition };
}

export function validate(
    data: Record<string, unknown>,
    schema: SchemaDoc | SchemaDefinition,
): string[] {
    const doc = normalize(schema);
    const errors: string[] = [];
    for (const [field, def] of Object.entries(doc.fields)) {
        errors.push(...validateValue(data[field], def, doc, field));
    }
    return errors;
}

function validateValue(
    value: unknown,
    def: FieldDefinition,
    doc: SchemaDoc,
    path: string,
): string[] {
    const rawType = def["@type"];
    const nullable = rawType.endsWith("| null");
    const baseType = nullable ? rawType.replace("| null", "").trim() : rawType;

    if (value === undefined || value === null) {
        return nullable ? [] : [`${path}: missing required field`];
    }

    const errors: string[] = [];
    if (BUILT_INS.has(baseType)) {
        errors.push(...validateBuiltIn(value, baseType, def, doc, path));
    } else {
        const customType = doc.types?.[baseType];
        if (!customType) {
            errors.push(`${path}: unknown @type "${rawType}"`);
            return errors;
        }
        errors.push(...validateCustomType(value, customType, doc, path));
    }

    if (def.constraints) {
        errors.push(...applyConstraints(value, def.constraints, doc, path));
    }
    return errors;
}

function validateBuiltIn(
    value: unknown,
    baseType: string,
    def: FieldDefinition,
    doc: SchemaDoc,
    path: string,
): string[] {
    const errors: string[] = [];
    switch (baseType) {
        case "string":
            if (typeof value !== "string") errors.push(`${path}: must be a string, got ${typeof value}`);
            break;
        case "number":
            if (typeof value !== "number") errors.push(`${path}: must be a number, got ${typeof value}`);
            break;
        case "boolean":
            if (typeof value !== "boolean") errors.push(`${path}: must be a boolean, got ${typeof value}`);
            break;
        case "bytes":
            if (!(value instanceof Uint8Array) && !ArrayBuffer.isView(value)) {
                errors.push(`${path}: must be bytes (Uint8Array)`);
            }
            break;
        case "handle": {
            const asObj = value as Record<string, unknown>;
            if (typeof asObj?.uri !== "string") errors.push(`${path}: is a handle — expected { uri: string }`);
            break;
        }
        case "array": {
            if (!Array.isArray(value)) {
                errors.push(`${path}: must be an array, got ${typeof value}`);
                break;
            }
            const items = def.items as FieldDefinition | undefined;
            if (items) {
                value.forEach((item, i) => errors.push(...validateValue(item, items, doc, `${path}[${i}]`)));
            }
            break;
        }
        case "object": {
            if (typeof value !== "object" || value === null) {
                errors.push(`${path}: must be an object, got ${typeof value}`);
                break;
            }
            const items = def.items as Record<string, FieldDefinition> | undefined;
            if (items) {
                const obj = value as Record<string, unknown>;
                for (const [k, sub] of Object.entries(items)) {
                    errors.push(...validateValue(obj[k], sub, doc, `${path}.${k}`));
                }
            }
            break;
        }
        case "encrypted":
            // opaque payload — no value-level checks
            break;
    }
    return errors;
}

function validateCustomType(
    value: unknown,
    type: TypeDefinition,
    doc: SchemaDoc,
    path: string,
): string[] {
    if (typeof value !== "object" || value === null) {
        return [`${path}: expected object for custom type`];
    }
    const obj = value as Record<string, unknown>;
    const errors: string[] = [];
    for (const [k, subDef] of Object.entries(type.shape)) {
        errors.push(...validateValue(obj[k], subDef, doc, `${path}.${k}`));
    }
    if (type.constraints) {
        errors.push(...applyConstraints(value, type.constraints, doc, path));
    }
    return errors;
}

export function applyConstraints(
    value: unknown,
    constraints: Constraint[],
    doc: SchemaDoc,
    path: string,
): string[] {
    const errors: string[] = [];
    for (const c of constraints) {
        const err = applyOne(value, c, doc, path);
        if (err) errors.push(err);
    }
    return errors;
}

function applyOne(value: unknown, c: Constraint, doc: SchemaDoc, path: string): string | null {
    switch (c.kind) {
        case "regex": {
            if (typeof value !== "string") return `${path}: regex constraint requires a string`;
            return new RegExp(c.pattern).test(value) ? null : `${path}: must match /${c.pattern}/`;
        }
        case "enum": {
            return c.values.includes(value as string | number | boolean)
                ? null
                : `${path}: must be one of ${JSON.stringify(c.values)}`;
        }
        case "range": {
            if (typeof value !== "number") return `${path}: range constraint requires a number`;
            if (c.min !== undefined && (c.exclusive ? value <= c.min : value < c.min)) {
                return `${path}: must be ${c.exclusive ? ">" : ">="} ${c.min}`;
            }
            if (c.max !== undefined && (c.exclusive ? value >= c.max : value > c.max)) {
                return `${path}: must be ${c.exclusive ? "<" : "<="} ${c.max}`;
            }
            return null;
        }
        case "length": {
            const len =
                typeof value === "string" ? value.length :
                Array.isArray(value) ? value.length :
                value instanceof Uint8Array ? value.length :
                -1;
            if (len < 0) return `${path}: length constraint requires a string, array, or bytes`;
            if (c.min !== undefined && len < c.min) return `${path}: length must be >= ${c.min}`;
            if (c.max !== undefined && len > c.max) return `${path}: length must be <= ${c.max}`;
            return null;
        }
        case "ref": {
            const target = doc.types?.[c.type];
            if (!target) return `${path}: ref constraint references unknown type "${c.type}"`;
            const subErrors = validateCustomType(value, target, doc, path);
            return subErrors.length === 0 ? null : subErrors.join("\n");
        }
    }
}
