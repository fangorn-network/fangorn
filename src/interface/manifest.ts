import type { VaultEntry, VaultManifest } from "../types/index.js";

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
