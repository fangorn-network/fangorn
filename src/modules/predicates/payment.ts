import { createAccBuilder } from "@lit-protocol/access-control-conditions";
import { Address, Hex } from "viem";
import { Predicate, PredicateDescriptor } from "./types";
import StorageProvider from "../../providers/storage";
import { CID } from "multiformats/cid";

// hash this all into a transcript => that's the commitment
export interface PaymentPredicateParams {
	// the usdc price
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

        const go = async (supportedNetwork, paywallAddress, commitment, price) => {
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

			const paidAmount = await paywall.checkSettlement(commitment, callerAddress);

			if (paidAmount < price) {
				Lit.Actions.setResponse({ success: false, response: "goodbye" });
				throw new Error("x402: Payment Required");
			}

			Lit.Actions.setResponse({ response: true.toString() });

			return true.toString()
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

	// very very very unfortunately, the latest pinata sdk only supports ipfs CID v1
	// but it does NOT use protobuf, meaning we can't convert it to CID v0
	// However, Lit nodes seem to use a legacy gateway that requires CID v0
	// and so, we need to pass the jwt to the predicate...
	// there's probably a better way to go about this but this works for now
	// but I'm not very comfortable with it...
	private async toLitActionIpfsHash(): Promise<string> {
		const jwt = process.env.PINATA_JWT!;
		if (!jwt) throw new Error("PINATA_JWT is required");

		const content = this.toLitAction();
		const name = "lit-action-payment-predicate-v1";

		const form = new FormData();
		form.append("file", new Blob([content], { type: "text/plain" }), name);
		form.append("pinataOptions", JSON.stringify({ cidVersion: 0 }));
		form.append("pinataMetadata", JSON.stringify({ name }));

		const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
			method: "POST",
			headers: { Authorization: `Bearer ${jwt}` },
			body: form,
		});

		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Pinata upload failed: ${res.status} - ${text}`);
		}

		const resData = await res.json();
		this.litActionCid = resData.IpfsHash;

		return this.litActionCid!;
	}
}
