import { isCancel } from "@clack/prompts";

export * from "./cli.js";

export const handleCancel = (value: unknown) => {
	if (isCancel(value)) {
		process.exit(0);
	}
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
