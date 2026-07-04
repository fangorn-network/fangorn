# Archived design notes

These documents are **superseded by [`../PROTOCOL.md`](../PROTOCOL.md)** — the single
Fangorn guide. They are kept because a few carry detail the guide summarizes (exact code
seams, gap analyses, per-slice build plans) and because some source-code comments still
point at their section numbers.

Treat the guide as the source of truth. Reach for these only for depth:

| File | What it held | Superseded by |
|---|---|---|
| `FRAMEWORK.md` | Original ecosystem theory (semantic-web thesis, contract chain, gaps A–E, layer model) | Guide §What-is / §14 |
| `GIT_NATIVE_REDESIGN.md` | Umbrella of the redesign (invariants I1–I9, five planes, merged roadmap) | Guide §3–§13 |
| `GIT_NATIVE_DATA_MODEL.md` | First-principles object model (Blob/Tree/Commit/Ref, the seven invariants) | Guide §3–§7, §15 |
| `GIT_NATIVE_ACCESS_CONTROL.md` | Gadget predicate layer (one rule form gates read + write) | Guide §7–§8 |
| `GIT_NATIVE_IMPLEMENTATION_PLAN.md` | Vertical build slices S0–S7 (detailed acceptance demos) | Guide §13 |
| `GIT_NATIVE_PRIOR_ART.md` | Prior-art scan + substrate decisions (prolly tree, Lit, dag-cbor, …) | Guide §12 |
| `DATASOURCE_GIT_MODEL.md` | Code-grounded v0.2 (exact seams in contract/SDK/quickbeam) | Guide §13, source comments |
| `CROSS_PUBLISHER_LINKING.md` / `_PLAN.md` | Full identity/view/linkset design + build plan | Guide §6 |
| `BUNDLE_CHUNKING.md` | Sharded bundle publish (laptop-sized transactions) | Guide §13 (deferred item) |
| `encryption.md` | Seal/unseal + gadget-gated access detail | Guide §8 |
| `guide.md` | Early quickstart | Guide §11 |
