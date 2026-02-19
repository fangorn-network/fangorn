// this file contains various implementations of gadgets based on accs

import {
	createAccBuilder,
	EvmChain,
} from "@lit-protocol/access-control-conditions";
import { AccGadget } from "../acc";

export function identity(chain: EvmChain, who: string): AccGadget {
	return new AccGadget(
		createAccBuilder().requireWalletOwnership(who).on(chain).build(),
		"Caller must match the specified wallet.",
	);
}
