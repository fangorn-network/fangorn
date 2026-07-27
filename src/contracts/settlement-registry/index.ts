import type { Address, Hex, PublicClient } from "viem";
import { SETTLEMENT_REGISTRY_ABI } from "./abi.js";

/**
 * Read-only client for the Settlement Registry — the settlement rail behind
 * gated reads. A resource is identified by its `resourceId` (bytes32, the same
 * value produced by `resourceId(owner, schemaId, name)` in utils/manifest and
 * bound into a sealed field's HKDF key).
 *
 * `getPrice(resourceId) === 0` means the resource is free (the worker lets any
 * signed request through); a non-zero price means the caller must have settled.
 * The pay/settle write path is a separate payment rail and is not modeled here.
 */
export class SettlementRegistryClient {
	constructor(
		private contractAddress: Address,
		private publicClient: PublicClient,
	) {}

	/** True if `stealthAddress` has settled for `resourceId`. */
	async isSettled(stealthAddress: Address, resourceId: Hex): Promise<boolean> {
		return this.publicClient.readContract({
			address: this.contractAddress,
			abi: SETTLEMENT_REGISTRY_ABI,
			functionName: "isSettled",
			args: [stealthAddress, resourceId],
		});
	}

	/** Price of `resourceId` in the settlement token's smallest unit; 0 = free. */
	async getPrice(resourceId: Hex): Promise<bigint> {
		return this.publicClient.readContract({
			address: this.contractAddress,
			abi: SETTLEMENT_REGISTRY_ABI,
			functionName: "getPrice",
			args: [resourceId],
		});
	}
}
