import { AccessControlConditions } from "@lit-protocol/access-control-conditions";
import { Gadget, GadgetDescriptor } from "./types";

export class AccGadget implements Gadget {
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

	toDescriptor(): GadgetDescriptor {
		return {
			type: this.type,
			description: this.description,
			acc: this.acc,
		};
	}
}
