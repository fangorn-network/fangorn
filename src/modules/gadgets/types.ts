import { UnifiedAccessControlCondition } from "@lit-protocol/access-control-conditions";

export interface Gadget {
	// Unique identifier for this gadget type
	type: string;
	// Generate the Lit action code
	toLitAction(): string;
	// Generate the ACC for Lit
	toAccessCondition(): Promise<UnifiedAccessControlCondition[]>;
	// Serialize to a descriptor (for storage)
	toDescriptor(): Promise<GadgetDescriptor>;
}

export interface GadgetDescriptor {
	type: string;
	description?: string;
	acc?: UnifiedAccessControlCondition;
	params?: Record<string, unknown>;
}
