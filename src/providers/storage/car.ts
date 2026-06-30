import * as UnixFS from "@ipld/unixfs";
import { CarWriter } from "@ipld/car";
import type { CID } from "multiformats/cid";
import { serialize } from "./utils.js";

/** A content-addressed IPLD block. */
interface Block { cid: CID; bytes: Uint8Array }

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
    return name.replace(/[/\x00]/g, "_");
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
    const bytes = await writeCarBytes(root, blocks);
    const uriByName: Record<string, string> = {};
    for (const { name, entry } of dirNames) uriByName[name] = `ipfs://${root.toString()}/${entry}`;
    return { bytes, root, uriByName };
}

/** Serialize blocks into CAR v1 bytes under a single known root. */
async function writeCarBytes(root: CID, blocks: Block[]): Promise<Uint8Array> {
    const { writer, out } = CarWriter.create([root]);
    const collected: Uint8Array[] = [];
    const sink = (async () => { for await (const part of out) collected.push(part); })();
    // Release each block as soon as the writer has serialized it so GC can reclaim
    // the encoded blocks while we accumulate CAR output — peak ~2× group, not 3×.
    for (let i = 0; i < blocks.length; i++) {
        await writer.put(blocks[i]);
        blocks[i] = undefined as unknown as Block;
    }
    await writer.close();
    await sink;

    let total = 0;
    for (const p of collected) total += p.length;
    const buf = new Uint8Array(total);
    let off = 0;
    for (const p of collected) { buf.set(p, off); off += p.length; }
    return buf;
}
