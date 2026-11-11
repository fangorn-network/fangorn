import { isCancel, select } from "@clack/prompts";
import { SupportedNetworks } from "../config.js";

export * from "./cli.js";

export const handleCancel = (value: unknown) => {
	if (isCancel(value)) {
		process.exit(0);
	}
};

/** Asks which supported network to use, and returns its name ("baseSepolia", ...). */
export const selectChain = async (): Promise<string> => {
	const choice = await select({
		message: "Pick your chain.",
		options: Object.entries(SupportedNetworks).map(([value, c]) => ({
			value,
			label: c.chain.name,
		})),
	});
	handleCancel(choice);
	return String(choice);
};

export function parseGadgetArg(raw: string): { type: string; args: string[] } {
	const match = /^(\w+)\(([^)]*)\)$/.exec(raw);
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
