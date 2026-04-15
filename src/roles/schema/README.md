# Schema

Fangorn introduces a hierarchical type system for defining encrypted fields with a json schema.

Right now, if you want an agent to find and purchase music, someone has to write a custom plugin for Bandcamp, a custom plugin for Splice, a custom plugin for every platform. Each one is bespoke. Each one requires a business relationship. Each one can be revoked.
Fangorn's schema layer means any publisher who emits schema-conformant data to IPFS is automatically queryable by any agent that knows the Fangorn vocabulary. No platform relationship. No custom integration. The schema is the API.

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
            audio: { "@type": "handle", uri: "r2://tracks/track-01.mp3" },
        },
    },
    {
        name: "track-02",
        fields: {
            title: "Track Two",
            artist: "Alice",
            audio: { "@type": "handle", uri: "r2://tracks/track-02.mp3" },
        },
    },
]
```

Note: The schema 'handle' type is part of an extensible system. In the future, we will include additional handles, like FHE, threshold encryption, and beyond.

