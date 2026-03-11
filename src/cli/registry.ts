import { Address } from "viem";
import { PaymentGadget } from "../modules/gadgets/payment";
import { Gadget } from "../modules/gadgets";
import { select, text } from "@clack/prompts";
import { handleCancel } from ".";
import { computeTagCommitment, fieldToHex } from "../utils";

export const GADGET_REGISTRY = {
	payment: {
		label: "Payment (x402)",
		argSchema: ["usdcPrice"],
		build: (namedParams: Record<string, unknown>) =>
			new PaymentGadget(namedParams as any),
		prompts: [
			{ key: "usdcPrice", message: "USDC price:", placeholder: "1.00" },
			{
				key: "chainName",
				message: "Chain name:",
				placeholder: "arbitrumSepolia",
			},
			{
				key: "settlementTrackerContractAddress",
				message: "Settlement tracker contract address:",
				placeholder: "0x...",
			},
			// commitment is derived
		],
	},
	// future gadgets go here
} as const;

export async function selectGadget(
	owner: Address,
	name: string,
	tag: string,
	price: string,
): Promise<Gadget> {
	const gadgetType = await select({
		message: "Select access control gadget:",
		options: Object.entries(GADGET_REGISTRY).map(([value, { label }]) => ({
			value,
			label,
		})),
	});
	handleCancel(gadgetType);

	const def = GADGET_REGISTRY[gadgetType as GadgetType];
	const params: Record<string, unknown> = {};

	for (const { key, message, placeholder } of def.prompts) {
		const val = await text({ message, placeholder });
		handleCancel(val);
		params[key] = val;
	}

	// commitment is always derived
	const commitment = await computeTagCommitment(owner, name, tag, price);
	params.commitment = fieldToHex(commitment);

	return def.build(params);
}

export type GadgetType = keyof typeof GADGET_REGISTRY;
