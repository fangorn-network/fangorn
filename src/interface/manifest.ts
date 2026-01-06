import { downloadFromPinata } from "../uploadToIpfs.js";
import { fieldToHex, hashCidToField } from "./merkle.js";
import type { VaultEntry, VaultManifest } from "./types.js";

// export function createManifest(
//     cids: string[],
//     tags: string[],
// ): { manifest: VaultManifest; root: bigint } {
//     const { root, layers } = buildTree(cids);

//     const entries: VaultEntry[] = cids.map((cid, i) => ({
//         tag: tags[i] || `file-${i}`,
//         cid,
//         index: i,
//         leaf: fieldToHex(hashCidToField(cid)),
//     }));

//     const manifest: VaultManifest = {
//         version: 1,
//         poseidon_root: fieldToHex(root),
//         entries,
//         tree: layers.map((layer) => layer.map(fieldToHex)),
//     };

//     return { manifest, root };
// }

export async function fetchManifest(
	manifestCid: string,
	// TODO
	// pinata: PinataSDK
): Promise<VaultManifest> {
	const response = await downloadFromPinata(manifestCid);
	return response as VaultManifest;
}

export function findEntry(
	manifest: VaultManifest,
	tag: string,
): VaultEntry | undefined {
	return manifest.entries.find((e) => e.tag === tag);
}

export function findEntryByCid(
	manifest: VaultManifest,
	cid: string,
): VaultEntry | undefined {
	return manifest.entries.find((e) => e.cid === cid);
}
