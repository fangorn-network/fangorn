import { UnifiedAccessControlCondition } from "@lit-protocol/access-control-conditions";
import { Address, Hex } from "viem";

export interface Gadget {
	readonly type: string;
	/** Hook contract called by SettlementRegistry during settle(). Zero address = no hook. */
	hookAddress(): Address;
	/** ABI-encoded params forwarded to the hook. "0x" = no params. */
	hookParams(): Hex;
	/** The ACC baked into the ciphertext at encryption time. Must match what the hook produces. */
	toAccessCondition(): UnifiedAccessControlCondition[];
	/** Stored in the manifest so consumers/agents know what they're buying. */
	toDescriptor(): GadgetDescriptor;
}
 
export interface GadgetDescriptor {
	type: string;
	description?: string;
	/** Hook contract address — zero address for SettledGadget */
	hookAddress: Address;
	/** The ACC stored alongside the ciphertext */
	acc?: UnifiedAccessControlCondition[];
	/** Human-readable params for display and agent consumption */
	params?: Record<string, unknown>;
}
 