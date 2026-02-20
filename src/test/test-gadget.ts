import {
	createAccBuilder,
	EvmChain,
} from "@lit-protocol/access-control-conditions";
import { AccGadget } from "../modules/gadgets/acc";

export function emptyWallet(chain: EvmChain): AccGadget {
	return new AccGadget(
		createAccBuilder().requireEthBalance("0", "=").on(chain).build(),
		"Caller must have zero ETH balance",
	);
}
