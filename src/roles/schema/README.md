# Schema

Fangorn introduces a hierarchical type system for defining encrypted fields with a json schema.

Right now, if you want an agent to find and purchase music, someone has to write a custom plugin for Bandcamp, a custom plugin for Splice, a custom plugin for every platform. Each one is bespoke. Each one requires a business relationship. Each one can be revoked.
Fangorn's schema layer means any publisher who emits schema-conformant data to IPFS is automatically queryable by any agent that knows the Fangorn vocabulary. No platform relationship. No custom integration. The schema is the API.

For example, applying this to schema.org, which offers a common set of schemas that can already be understood by web crawlser, ai agents, and search engines, would let you construct a schema that can be conditionally accessed using Fangorn. That is, a schema could look like:

``` json
{
  "@context": "https://schema.org",
  "@type": "encrypted",
  "acc": "Payment(0.0001)",
  "author": "John Tolkien",
  "contentUrl": "ipfs://bafy...",
  "description": "Recorded on a terrace of Girona a sunday morning",
  "duration": "T0M15S",
  "encodingFormat": "audio/mpeg",
  "name": "12oclock_girona.mp3"
}
```

an agent or web scraper can then use `x402f` to gain access to the audio url!