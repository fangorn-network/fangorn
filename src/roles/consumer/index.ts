// import { type Address, type Hex, type WalletClient, encodePacked, keccak256 } from "viem";
// import { type Identity } from "@semaphore-protocol/identity";
// import {
//     ClaimParams,
//     ClaimResult,
//     FetchParams,
//     FetchResult,
//     PurchaseParams,
//     PurchaseResult,
// } from "./types";
// import { Manifest, ManifestEntry, ResolvedHandleField } from "../publisher/types";
// import { PinataBackend } from "../../providers/storage";
// import { PublisherRegistry } from "../../contracts/publisher-registry";

// export class ConsumerRole {
//     constructor(
//         private readonly registry: PublisherRegistry,
//     ) { }

//     // async checkManifestExists(who: Address, schemaId: Hex, name: string): Promise<boolean> {
//     //     try {
//     //         const ds = await this.registry.get(who, schemaId, name);
//     //         return !!ds.manifestCid && ds.manifestCid !== "";
//     //     } catch {
//     //         return false;
//     //     }
//     // }

//     // async getEntry(owner: Address, schemaId: Hex, name: string, gateway?: string): Promise<ManifestEntry | undefined> {
//     //     try {
//     //         const ds = await this.registry.get(owner, schemaId, name);
//     //         if (!ds.manifestCid || ds.manifestCid === "") return undefined;

//     //         const manifest = await PinataBackend.getStatic<Manifest>(ds.manifestCid, gateway);

//     //         manifest.entries.forEach(entry => {
//     //             if (entry.name === name) return entry;
//     //         });
//     //         return undefined;
//     //     } catch {
//     //         return undefined;
//     //     }
//     // }

//     /**
//      * Resolves the handle URI for a specific field
//      * and fetches it via the worker in one call.
//      */
//     async fetchField(
//         owner: Address,
//         schemaId: Hex,
//         name: string,
//         field: string,
//         nullifier: string,
//         walletClient: WalletClient,
//     ): Promise<FetchResult> {
//         // TODO: entry can be undefined
//         const entry = await this.getEntry(owner, schemaId, name)
//         if (!entry) throw new Error("Entry not found")

//         const fieldValue = entry.fields[field];

//         if (!fieldValue || typeof fieldValue !== 'object') {
//             throw new Error(`Field "${field}" is missing or is not a handle field`)
//         }

//         if (typeof fieldValue !== 'object' || !('@type' in fieldValue)) {
//             throw new Error(`Field "${field}" is missing or is not a handle field`)
//         }

//         if (fieldValue['@type'] !== 'handle') {
//             throw new Error(`Field "${field}" is not a handle field. Read it directly from the entry`)
//         }

//         const handle = fieldValue as ResolvedHandleField;
//         const objectKey = parseObjectKey(handle.uri);
//         const resourceId = this.deriveResourceId(owner, schemaId, name)

//         return this.fetch({
//             nullifier,
//             resourceId,
//             objectKey,
//             workerUrl: handle.workerUrl,
//             walletClient,
//         })
//     }

//     async isRegistered(
//         owner: Address,
//         schemaId: Hex,
//         name: string,
//         identity: Identity,
//     ): Promise<boolean> {
//         const resourceId = this.deriveResourceId(owner, schemaId, name);
//         return this.settlementRegistry.isRegistered(resourceId, identity.commitment);
//     }

//     private deriveResourceId(owner: Address, schemaId: Hex, name: string): Hex {
//         return DataSourceRegistry.resourceId(owner, schemaId, name);
//     }
// }

// function parseObjectKey(uri: string): string {
//     if (uri.startsWith('r2://')) return uri.slice('r2://'.length)
//     if (uri.startsWith('ipfs://')) return uri.slice('ipfs://'.length)
//     return uri
// }