import {
	createAccBuilder,
	EvmChain,
} from "@lit-protocol/access-control-conditions";
import { AccPredicate } from "../modules/predicates/acc";

export function emptyWallet(chain: EvmChain): AccPredicate {
	return new AccPredicate(
		createAccBuilder().requireEthBalance("0", "=").on(chain).build(),
		"Caller must have zero ETH balance",
	);
}
