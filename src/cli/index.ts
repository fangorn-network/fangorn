import { isCancel, select } from "@clack/prompts";
import getNetwork from "../config";

export * from "./cli.js";

export const getChain = (chainStr: string) => {
	return getNetwork(chainStr);
};

export const handleCancel = (value: unknown) => {
	if (isCancel(value)) {
		process.exit(0);
	}
};

export const selectChain = async () => {
	const chainChoice = await select({
		message: "Pick your chain.",
		options: [
			{ value: "arbitrumSepolia", label: "Arbitrum Sepolia" },
			{ value: "baseSepolia", label: "Base Sepolia" },
		],
	});
	handleCancel(chainChoice);
	return getNetwork(chainChoice.toString());
};

export function parseGadgetArg(raw: string): { type: string; args: string[] } {
	const match = raw.match(/^(\w+)\(([^)]*)\)$/);
	if (!match)
		throw new Error(
			`Invalid gadget format: "${raw}". Expected e.g. Payment(0.00001)`,
		);
	const type = match[1].toLowerCase();
	const args = match[2]
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	return { type, args };
}
