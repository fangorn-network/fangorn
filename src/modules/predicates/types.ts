export interface Predicate {
	// Unique identifier for this predicate type
	type: string;
	// Generate the Lit action code
	toLitAction(): string;
	// Generate the ACC for Lit
	toAccessCondition(): any;
	// Serialize to a descriptor (for storage)
	toDescriptor(): PredicateDescriptor;
}

export interface PredicateDescriptor {
	type: string;
	description?: string;
	acc?: any;
	params?: Record<string, unknown>;
}
