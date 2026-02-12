import type { VaultEntry, VaultManifest } from "../types/index.js";
export declare function findEntry(manifest: VaultManifest, tag: string): VaultEntry | undefined;
export declare function findEntryByCid(manifest: VaultManifest, cid: string): VaultEntry | undefined;
