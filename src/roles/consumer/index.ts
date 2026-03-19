import { type Address, type Hex, type WalletClient } from "viem";
import { type Identity } from "@semaphore-protocol/identity";
import { DataSourceRegistry } from "../../registries/datasource-registry";
import { SettlementRegistry } from "../../registries/settlement-registry";
import StorageProvider from "../../providers/storage";
import { EncryptionService } from "../../modules/encryption";
import { AccessParams, AccessResult, ClaimParams, ClaimResult, DecryptParams, PurchaseParams, PurchaseResult } from "./types";
import { EncryptedPayload } from "../../modules/encryption/types";
import { Manifest, ManifestEntry, ResolvedEncryptedField } from "../publisher/types";

export class ConsumerRole {
	constructor(
		private readonly dataSourceRegistry: DataSourceRegistry,
		private readonly settlementRegistry: SettlementRegistry,
		private readonly storage: StorageProvider<unknown>,
		private readonly encryptionService: EncryptionService,
		// private readonly walletClient: WalletClient,
		private readonly domain: string,
	) {}
 
	/**
	 * Phase 1: Pay and register a Semaphore identity commitment for a resource.
	 * The resource is identified by (owner, schemaId, tag) — one resource per record.
	 * All encrypted fields within a record share the same resource gate.
	 */
	async purchase(params: PurchaseParams): Promise<PurchaseResult> {
		const resourceId = this.deriveResourceId(params.owner, params.schemaId, params.tag);
		const txHash = await this.settlementRegistry.register({
			resourceId,
			...params.payment,
		});
		return { txHash, resourceId };
	}
 
	/**
	 * Phase 2: Prove group membership and claim access to a record.
	 */
	async claim(params: ClaimParams): Promise<ClaimResult> {
		const resourceId = this.deriveResourceId(params.owner, params.schemaId, params.tag);
		const { hash, nullifier } = await this.settlementRegistry.settle({
			resourceId,
			...params.proof,
		});
		return { txHash: hash, nullifier, resourceId };
	}
 
	/**
	 * Decrypt a specific encrypted field within a record.
	 *
	 * One purchase + claim unlocks ALL encrypted fields in the record —
	 * the resource is at the record (tag) level, not the field level.
	 * This method can be called once per encrypted field without re-purchasing.
	 *
	 * Plain fields can be read freely via getEntry() without any of this.
	 */
	async decrypt(params: DecryptParams): Promise<Uint8Array> {
		const resourceId = this.deriveResourceId(params.owner, params.schemaId, params.tag);
 
		if (!params.skipSettlementCheck) {
			if (!params.identity) {
				throw new Error(
					"identity is required for settlement verification. " +
					"Pass skipSettlementCheck: true for owner / out-of-band flows.",
				);
			}
			const registered = await this.settlementRegistry.isRegistered(
				resourceId,
				params.identity.commitment,
			);
			if (!registered) {
				throw new Error(
					`Access denied: identity not registered for resource ${resourceId}. ` +
					`Call purchase() and wait for confirmation before decrypting.`,
				);
			}
		}
 
		const entry = await this.getEntry(params.owner, params.schemaId, params.tag);
		const fieldValue = entry.fields[params.field];
 
		if (!fieldValue || typeof fieldValue !== "object" || (fieldValue as ResolvedEncryptedField)["@type"] !== "encrypted") {
			throw new Error(
				`Field "${params.field}" in record "${params.tag}" is not an epsetindcrypted field`,
			);
		}
 
		const encryptedField = fieldValue as ResolvedEncryptedField;
		const encrypted = (await this.storage.retrieve(
			encryptedField.handle.cid,
		)) as EncryptedPayload;
 
		const authContext =
			params.authContext ??
			(await this.encryptionService.createAuthContext(
				params.walletClient, 
				this.domain, 
				params.nullifierHash
			));
 
		const decrypted = await this.encryptionService.decrypt(encrypted, authContext);
		return decrypted.data;
	}
 
	// /**
	//  * Convenience: purchase → await confirmation → claim → decrypt a field.
	//  * For agent/script flows that can block on each step.
	//  */
	// async access(params: AccessParams): Promise<AccessResult> {
	// 	const { owner, schemaId, tag, field, identity, payment, proof, authContext } = params;
 
	// 	const { resourceId } = await this.purchase({ owner, schemaId, tag, identity, payment });
	// 	await this.awaitRegistration(resourceId, identity.commitment);
	// 	await this.claim({ owner, schemaId, tag, proof });
	// 	const data = await this.decrypt({ owner, schemaId, tag, field, identity, authContext });
	// 	const entry = await this.getEntry(owner, schemaId, tag);
 
	// 	return { data, resourceId, entry };
	// }
 
	async getManifest(owner: Address, schemaId: Hex): Promise<Manifest | undefined> {
		try {
			const ds = await this.dataSourceRegistry.getManifest(owner, schemaId);
			if (!ds.manifestCid || ds.manifestCid === "") return undefined;
			return (await this.storage.retrieve(ds.manifestCid)) as Manifest;
		} catch {
			return undefined;
		}
	}
 
	async getEntry(owner: Address, schemaId: Hex, tag: string): Promise<ManifestEntry> {
		const manifest = await this.getManifest(owner, schemaId);
		if (!manifest) throw new Error(`No manifest found for owner ${owner} / schemaId ${schemaId}`);
		const entry = manifest.entries.find((e) => e.tag === tag);
		if (!entry) throw new Error(`Entry not found: "${tag}"`);
		return entry;
	}
 
	async isRegistered(
		owner: Address,
		schemaId: Hex,
		tag: string,
		identity: Identity,
	): Promise<boolean> {
		const resourceId = this.deriveResourceId(owner, schemaId, tag);
		return this.settlementRegistry.isRegistered(resourceId, identity.commitment);
	}
 
	// ── Private ───────────────────────────────────────────────────────────────
 
	private deriveResourceId(owner: Address, schemaId: Hex, tag: string): Hex {
		return SettlementRegistry.deriveResourceId(owner, schemaId, tag);
	}
 
	private async awaitRegistration(
		resourceId: Hex,
		commitment: bigint,
		maxAttempts = 30,
		intervalMs = 2_000,
	): Promise<void> {
		for (let i = 0; i < maxAttempts; i++) {
			if (await this.settlementRegistry.isRegistered(resourceId, commitment)) return;
			await new Promise((resolve) => setTimeout(resolve, intervalMs));
		}
		throw new Error(
			`Timed out waiting for identity registration on resource ${resourceId}.`,
		);
	}
}
 