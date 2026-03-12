import {UnifiedAccessControlCondition } from "@lit-protocol/access-control-conditions";
import { Gadget, GadgetDescriptor } from "./types";

export class AccGadget implements Gadget {
	readonly type = "acc";

	constructor(
		private acc: UnifiedAccessControlCondition,
		private description?: string,
	) {}

	// Standard ACCs don't need custom Lit actions
	toLitAction(): string {
		return ``;
	}

	async toAccessCondition(): Promise<UnifiedAccessControlCondition[]> {
		return Promise.resolve([this.acc]);
	}

	async toDescriptor(): Promise<GadgetDescriptor> {
		return Promise.resolve({
			type: this.type,
			description: this.description,
			acc: this.acc,
		})
	}
}
