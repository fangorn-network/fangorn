export interface Gadget {
	// Unique identifier for this gadget type
	type: string;
	// Generate the Lit action code
	toLitAction(): string;
	// Generate the ACC for Lit
	toAccessCondition(): any;
	// Serialize to a descriptor (for storage)
	toDescriptor(): GadgetDescriptor;
}

export interface GadgetDescriptor {
	type: string;
	description?: string;
	acc?: any;
	params?: Record<string, unknown>;
}
