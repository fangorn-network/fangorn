import { type Address, type Hex } from "viem";
import { type Identity } from "@semaphore-protocol/identity";
import { DataSourceRegistry } from "../../registries/datasource-registry";
import { SettlementRegistry } from "../../registries/settlement-registry";
import StorageProvider from "../../providers/storage";
import { EncryptionService } from "../../modules/encryption";
import { ClaimParams, ClaimResult, DecryptParams, PurchaseParams, PurchaseResult } from "./types";
import { EncryptedPayload } from "../../modules/encryption/types";
import { Manifest, ManifestEntry, ResolvedEncryptedField } from "../publisher/types";
import { PrepareSettleParams, PrepareSettleResult, TransferWithAuthParams, TransferWithAuthPayload } from "../../registries/settlement-registry/types";

/**
 * The consumer namespace encapsulates all functionality relative to accessing and consuming data.
 */
export class ConsumerRole {
	constructor(
		private readonly dataSourceRegistry: DataSourceRegistry,
		private readonly settlementRegistry: SettlementRegistry,
		private readonly storage: StorageProvider<unknown>,
		private readonly encryptionService: EncryptionService,
		private readonly domain: string,
	) { }

	/**
	 * Builds the transfer with auth (ERC-3009) and signs it (EIP-712)
	 * @param params 
	 * @returns 
	 */
	async prepareRegister(params: TransferWithAuthParams): Promise<TransferWithAuthPayload> {
		return this.settlementRegistry.prepareTransferWithAuth(params);
	}

	/**
	 * Builds the zkp to prove you're in a semaphore 	 group
	 * @param params 
	 * @returns 
	 */
	async prepareSettle(params: PrepareSettleParams): Promise<PrepareSettleResult> {
		return this.settlementRegistry.prepareSettle(params);
	}

	/**
	 * Purchase the resource and register in the semaphore group (on success)
	 * @param params 
	 * @returns 
	 */
	async register(params: PurchaseParams): Promise<PurchaseResult> {
		const resourceId = this.deriveResourceId(params.owner, params.schemaId, params.tag);
		const txHash = await this.settlementRegistry.register({
			resourceId,
			identityCommitment: params.identityCommitment,
			relayerPrivateKey: params.relayerPrivateKey,
			preparedRegister: params.preparedRegister,
		});
		return { txHash, resourceId };
	}

	/**
	 * Claim access to a resource (prove settlement)
	 * Must register first. 
	 * @param params 
	 * @returns 
	 */
	async claim(params: ClaimParams): Promise<ClaimResult> {
		const resourceId = this.deriveResourceId(params.owner, params.schemaId, params.tag);
		const { hash, nullifier } = await this.settlementRegistry.settle({
			relayerPrivateKey: params.relayerPrivateKey,
			preparedSettle: params.preparedSettle,
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

		if (!fieldValue || typeof fieldValue !== "object") {
			throw new Error(`Field "${params.field}" is missing or invalid`);
		}
		// if (!fieldValue || typeof fieldValue !== "object" || (fieldValue as ResolvedEncryptedField)["@type"] !== "encrypted") {
		// 	throw new Error(
		// 		`Field "${params.field}" in record "${params.tag}" is not an epsetindcrypted field`,
		// 	);
		// }

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

	private deriveResourceId(owner: Address, schemaId: Hex, tag: string): Hex {
		return SettlementRegistry.deriveResourceId(owner, schemaId, tag);
	}
}
