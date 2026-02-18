import { AccessControlConditions } from "@lit-protocol/access-control-conditions";
import { Predicate, PredicateDescriptor } from "./types";

export class AccPredicate implements Predicate {
	readonly type = "acc";

	constructor(
		private acc: AccessControlConditions,
		private description?: string,
	) {}

	// Standard ACCs don't need custom Lit actions
	toLitAction(): string {
		return ``;
	}

	async toAccessCondition(): Promise<AccessControlConditions> {
		return this.acc;
	}

	toDescriptor(): PredicateDescriptor {
		return {
			type: this.type,
			description: this.description,
			acc: this.acc,
		};
	}
}
