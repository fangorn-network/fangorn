# Reading an old record from a long-lived repo exceeds Cloudflare's subrequest limit

## Summary

`readRecord` ([src/engine/index.ts](https://github.com/fangorn-network/fangorn/blob/main/src/engine/index.ts)) resolves each MST node and record block through `getBlock`. On a cache miss, `getBlock` walks the commit chain back from the head one link at a time. Each step reads the link's commit block (`directBlock`), then downloads and unpacks its CAR (`loadCar`). It stops only when the block turns up.

Because a commit's CAR holds only the blocks that commit introduced, the cost of a read grows with **how many commits ago the block was written**, not with the size of the repo. Each step back costs about 2 storage fetches. A block written N commits ago costs about 2N fetches, and a cold engine starts with nothing cached.

On Cloudflare Workers this fails once N passes roughly 500 (the paid plan allows 1000 subrequests per invocation, the free plan 50). The error is `Too many subrequests`.

## Where it shows up

The internet slop warehouse Worker (a westmarch indexer) reads records in two places:

- **publish:** each `uses` / `parent` link is checked with `engine.readRecord(publisher, repo, id)`.
- **get:** the MCP tool reads the record live.

Links to parts in the publisher's own short repo work. Links to parts in the warehouse's own repo, which has many seed and fix commits, fail every time. `get` on those parts fails too, with `Too many subrequests` showing directly.

## Reproduce

1. Commit to a repo, one record per commit, a few hundred times (`a0`, `a1`, … `aN`).
2. Read the first record from a fresh engine (empty cache) inside a Worker, or count `storage.getRawBlock` + `storage.getFile` calls in Node:

```js
const rec = await fangorn.engine.readRecord(publisher, repo, "a0");
// ~2N storage fetches; under workerd: Error: Too many subrequests
```

Reading the newest record (`aN`) costs only a few fetches, which is why the problem shows up only in older repos.

## Possible fixes

- **Checkpoint commits:** every K commits (or when the chain since the last checkpoint passes a threshold), write a commit whose CAR holds the full MST plus the live records. `getBlock` can stop at the first checkpoint, which caps a read at about 2K fetches. `restitch` already documents this pattern for stitches ("checkpoint with a full CAR").
- **Block → commit index:** each commit records where its MST's subtrees live (for example, MST node links carry the commit that wrote them as a hint), so `getBlock` jumps straight to the right CAR instead of walking.
- **At least:** give `getBlock` a fetch budget and throw a clear error ("block not found within N links") instead of running until the platform kills the request.

## Related

Callers that wrap `readRecord` in `.catch(() => null)` to mean "not found" turn this into a misleading `no part …` error. Making "no commits yet" a distinct error type, or returning null for it, would let callers catch only that case.
