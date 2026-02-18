import { createAccBuilder } from "@lit-protocol/access-control-conditions";
import { Address, Hex } from "viem";
import { Predicate, PredicateDescriptor } from "./types";
import StorageProvider from "../../providers/storage";

// hash this all into a transcript => that's the commitment
export interface PaymentPredicateParams {
	// the usdc price ONLY
	usdcPrice: string;
	commitment: Hex;
	chainName: string;
	settlementTrackerContractAddress: Address;
}

export class PaymentPredicate implements Predicate {
	readonly type = "payment";

	private litActionCid: string | null = null;

	constructor(
		private params: PaymentPredicateParams,
		private storage?: StorageProvider<any>,
	) {}

	// supports both arbitrum and base (sepolia)
	// todo: alternatively we can just pass the rpcurl as a param (set in the interface)
	toLitAction(): string {
		return `
        const arbitrumSepolia = "https://sepolia-rollup.arbitrum.io/rpc";
        const baseSepolia = "https://sepolia.base.org";

        const go = async (supportedNetwork, paywallAddress, commitment) => {
        let rpcUrl = baseSepolia;
        if (supportedNetwork == "arbitrumSepolia") rpcUrl = arbitrumSepolia;
        else if (supportedNetwork == "baseSepolia") rpcUrl = baseSepolia;
        else {
            throw new Error(
            'Unsupported network.Choose a supported network in the list ["arbitrumSepolia", "baseSepolia"].'
            );
        }

        const callerAddress = Lit.Auth.authSigAddress;
        const provider = new ethers.providers.JsonRpcProvider(rpcUrl);

        const paywallAbi = [
            "function checkSettlement(bytes32 commitment, address buyer) view returns (bool)",
        ];

        const paywall = new ethers.Contract(paywallAddress, paywallAbi, provider);

        const ok = await paywall.checkSettlement(commitment, callerAddress);

        if (!ok) {
            Lit.Actions.setResponse({ success: false, response: "goodbye" });
            throw new Error("x402: Payment Required");
        }

        Lit.Actions.setResponse({ response: ok.toString() });

        return ok.toString();
        };
    `;
	}

	async toAccessCondition(): Promise<any> {
		return createAccBuilder()
			.requireLitAction(
				await this.toLitActionIpfsHash(),
				"go",
				[
					this.params.chainName,
					this.params.settlementTrackerContractAddress,
					this.params.commitment,
				],
				"true",
			)
			.build();
	}

	toDescriptor(): PredicateDescriptor {
		return {
			type: this.type,
			description: "x402: Payment Required",
			acc: this.toAccessCondition(),
			params: { price: this.params.usdcPrice, token: "USDC" },
		};
	}

	private async toLitActionIpfsHash(): Promise<string> {
		if (this.storage! && !this.litActionCid) {
			this.litActionCid = await this.storage!.store(this.toLitAction(), {
				name: "lit-action-payment-predicate-v1",
			});
		}

		return this.litActionCid;
	}
}
