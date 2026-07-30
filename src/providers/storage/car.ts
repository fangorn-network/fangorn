import * as UnixFS from "@ipld/unixfs";
import type { CID } from "multiformats/cid";
import { serialize } from "./utils.js";
import { packCar as writeCarBytes } from "../../engine/car.js";
import type { Block } from "../../engine/graph.js";

/** Result of packing items into a single CAR. */
export interface PackedCar {
    /** The CAR bytes, ready to upload. */
    bytes: Uint8Array;
    /** Directory root CID — the single root Pinata recursively pins. */
    root: CID;
    /**
     * name → `ipfs://<root>/<name>` path URI. We address chunks by path through
     * the registered root, NOT by bare sub-block CID: a CAR upload registers only
     * the root as a "file", so a Pinata dedicated gateway 403s standalone sub-CIDs
     * but serves `<root>/<name>` (the root + its UnixFS directory entries). The
     * path still resolves deterministically to the file's content.
     */
    uriByName: Record<string, string>;
}

const enc = new TextEncoder();

/** Filenames inside the CAR's UnixFS directory; ':' is legal but we keep it tidy. */
function sanitize(name: string): string {
    // eslint-disable-next-line no-control-regex
    const sanitizeRegex = new RegExp("[/\\x00]", "g");
    return name.replace(sanitizeRegex, "_");
}

/**
 * Pack named payloads into a SINGLE CAR with a UnixFS directory root.
 *
 * Each item is UnixFS-encoded locally (so its real CID is known without a round
 * trip) and linked under one directory; that directory is the CAR's lone root,
 * so a `.car()` upload recursively pins every file block. Retrieval then uses
 * each item's standalone CID directly — the directory wrapper exists only to
 * give Pinata one thing to pin.
 *
 * Memory is ~2× the packed size (blocks held, then serialized to CAR bytes), so
 * callers must bound how much they hand to one call (see CAR_GROUP_* in publish).
 */
export async function packCar(items: { data: unknown; name: string }[]): Promise<PackedCar> {
    const blocks: Block[] = [];
    // @ipld/unixfs bundles its own multiformats, so its block/CID types are
    // nominally distinct from ours though structurally identical — cast at this
    // single boundary rather than threading two CID types through the module.
    const writable = new WritableStream<Block>({ write(b) { blocks.push(b); } });
    const writer = UnixFS.createWriter({ writable: writable as never });
    const dir = UnixFS.createDirectoryWriter(writer);
    const dirNames: { name: string; entry: string }[] = [];

    for (const { data, name } of items) {
        const bytes = enc.encode(serialize(data));
        const file = UnixFS.createFileWriter(writer);
        await file.write(bytes);
        const link = await file.close();
        const entry = sanitize(name);
        dir.set(entry, link);
        dirNames.push({ name, entry });
    }

    const dirLink = await dir.close();
    await writer.close();

    const root = dirLink.cid as unknown as CID;
    // The blocks array is ours alone, so let the writer release each block as it
    // serializes it — peak memory stays ~2× the group, not 3×.
    const bytes = await writeCarBytes(root, blocks, { release: true });
    const uriByName: Record<string, string> = {};
    for (const { name, entry } of dirNames) uriByName[name] = `ipfs://${root.toString()}/${entry}`;
    return { bytes, root, uriByName };
}
