export function findEntry(manifest, tag) {
    return manifest.entries.find((e) => e.tag === tag);
}
export function findEntryByCid(manifest, cid) {
    return manifest.entries.find((e) => e.cid === cid);
}
