# Schema

Fangorn introduces a hierarchical type system for defining encrypted fields with a json schema. Each field can specify a `@type` of `handle:MIME-TYPE` to indicate the location and mime type of the data. This is required for a webworker to fetch the data. 

For example, a basic music schema could look like:

``` json
{
  {
      "title": { "@type": "string" },
      "artist": { "@type": "string" },
      "audio": { "@type": "handle" },
  }
}
```

and data that satisifes the schema looks like:

``` json
[
    {
        name: "track-01",
        fields: {
            title: "Track One",
            artist: "Alice",
            audio: { "@type": "handle:", uri: "r2://tracks/track-01.mp3", workerUrl: "https://..." },
        },
    },
    {
        name: "track-02",
        fields: {
            title: "Track Two",
            artist: "Alice",
            audio: { "@type": "handle", uri: "r2://tracks/track-02.mp3", workerUrl: "https://..." },
        },
    },
]
```

Note: The schema 'handle' type is part of an extensible system. In the future, we will include additional handles, like FHE, threshold encryption, and beyond.

## Constraints

Any field can carry a `constraints` array of value-level checks. They are enforced by `validate` (and at publish time) and produce path-prefixed error messages such as `price.amount: must match /^[0-9]+$/`.

The constraint vocabulary is fixed:

| `kind`   | applies to            | options                                   |
| -------- | --------------------- | ----------------------------------------- |
| `regex`  | strings               | `pattern`                                 |
| `enum`   | any scalar            | `values: (string \| number \| boolean)[]` |
| `range`  | numbers               | `min?`, `max?`, `exclusive?`              |
| `length` | strings, arrays, bytes| `min?`, `max?`                            |
| `ref`    | objects               | `type` (a key in `types`, see below)      |

```json
{
  "title": { "@type": "string", "constraints": [{ "kind": "length", "min": 1, "max": 200 }] },
  "rating": { "@type": "number", "constraints": [{ "kind": "range", "min": 0, "max": 5 }] }
}
```

## Custom types

A schema can declare a reusable type vocabulary alongside its `fields`. A field then references a custom type by name in `@type`, and the validator recurses into its `shape`. This lets schema authors compose new validated shapes (payment, geo, email, …) out of the constraint primitives — no SDK change required.

```json
{
  "types": {
    "payment": {
      "shape": {
        "amount":   { "@type": "string", "constraints": [{ "kind": "regex", "pattern": "^[0-9]+$" }] },
        "currency": { "@type": "string", "constraints": [{ "kind": "enum", "values": ["USDC", "USDT", "DAI"] }] }
      }
    }
  },
  "fields": {
    "title": { "@type": "string", "constraints": [{ "kind": "length", "min": 1, "max": 200 }] },
    "price": { "@type": "payment" }
  }
}
```

A record satisfying this schema:

```json
{
  "name": "album-01",
  "fields": {
    "title": "Atom Heart Mother",
    "price": { "amount": "5000000", "currency": "USDC" }
  }
}
```

Both shapes are accepted everywhere a schema is taken: the bare flat map (`{ "title": { "@type": "string" } }`) and the explicit document form (`{ "types": {...}, "fields": {...} }`). The flat form is treated as `{ fields }` with no custom types. Custom types are persisted with the registered schema and re-applied when records are published against it.

Adding a new `kind` of constraint is an SDK release; composing the existing constraints into a new custom type is zero code.

