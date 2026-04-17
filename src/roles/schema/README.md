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
            audio: { "@type": "handle:audio/mp3", uri: "r2://tracks/track-01.mp3" },
        },
    },
    {
        name: "track-02",
        fields: {
            title: "Track Two",
            artist: "Alice",
            audio: { "@type": "handle:audio/mp3", uri: "r2://tracks/track-02.mp3" },
        },
    },
]
```

Note: The schema 'handle' type is part of an extensible system. In the future, we will include additional handles, like FHE, threshold encryption, and beyond.

