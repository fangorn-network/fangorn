import {
	AccessControlConditions,
	createAccBuilder,
	EvmChain,
} from "@lit-protocol/access-control-conditions";
import { AccessControlCondition } from "../modules/encryption/types";
import { Predicate } from "../modules/predicates";
import { PredicateDescriptor } from "../modules/predicates/types";

export class AccPredicate implements Predicate {
	readonly type = "acc";

	constructor(
		private acc: AccessControlConditions,
		private description?: string,
	) {}

	toLitAction(): string {
		return ``; // Standard ACCs don't need custom Lit actions
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

export function emptyWallet(chain: EvmChain): AccPredicate {
	return new AccPredicate(
		createAccBuilder().requireEthBalance("0", "=").on(chain).build(),
		"Caller must have zero ETH balance",
	);
}

// export function walletOwner(address: string, chain: string): AccPredicate {
//   return new AccPredicate(
//     createAccBuilder()
//       .requireWalletAddress(address)
//       .on(chain)
//       .build(),
//     `Only wallet ${address} can access`,
//   );
// }
