import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { chainNetwork, type ChainNetwork, skipChain } from "../test/testbed.js";

// The real CLI, run as a user would, against the contracts on anvil: the
// FANGORN_RPC_URL / FANGORN_DATA_REGISTRY overrides point it
// there, and each user is a HOME of their own, holding ~/.fangorn/config.json.

const ROOT = resolve(import.meta.dirname, "../..");
const TSX = join(ROOT, "node_modules/.bin/tsx");
const CLI = join(ROOT, "src/cli/cli.ts");

interface Run {
	code: number;
	out: string;
}

describe.skipIf(skipChain)("CLI (contracts on anvil)", () => {
	let net: ChainNetwork;
	const homes: string[] = [];

	beforeAll(async () => {
		net = await chainNetwork();
	}, 120_000);
	afterAll(() => {
		net.stop();
		for (const home of homes) rmSync(home, { recursive: true, force: true });
	});

	/** A user with a funded wallet and a config file. */
	async function user() {
		const home = mkdtempSync(join(tmpdir(), "fangorn-cli-"));
		homes.push(home);
		const privateKey: Hex = await net.wallet(generatePrivateKey());
		mkdirSync(join(home, ".fangorn"));
		const configPath = join(home, ".fangorn", "config.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				privateKey,
				chainName: "baseSepolia",
				pinataJwt: "",
				pinataGateway: "",
			}),
		);
		/** Run the CLI as this user. Run from HOME, so no repo `.env` is picked up. */
		const run = async (
			args: string[],
			env: Record<string, string> = {},
		): Promise<Run> => {
			const opts = {
				cwd: home,
				env: {
					PATH: process.env.PATH,
					HOME: home,
					FANGORN_RPC_URL: net.config.rpcUrl,
					FANGORN_DATA_REGISTRY: net.config.dataRegistryContractAddress,
					...env,
				},
			};
			try {
				const { stdout, stderr } = await promisify(execFile)(
					TSX,
					[CLI, ...args],
					opts,
				);
				return { code: 0, out: stdout + stderr };
			} catch (e) {
				const err = e as { code?: number; stdout?: string; stderr?: string };
				return {
					code: err.code ?? 1,
					out: (err.stdout ?? "") + (err.stderr ?? ""),
				};
			}
		};
		return { run };
	}

	// The card flow itself is in cards.e2e.test.ts; here, only what the CLI adds.
	it("card needs a repo: --repo, or the one tracked here", async () => {
		const u = await user();
		const out = await u.run([
			"card",
			"https://example.invalid/card.json",
			"--skip-register",
		]);
		expect(out.code).toBe(1);
		expect(out.out).toContain("not a fangorn repo");
	}, 60_000);

	it("rejects an override that is not an address", async () => {
		const owner = await user();
		const bad = await owner.run(["wallet"], {
			FANGORN_DATA_REGISTRY: "not-an-address",
		});
		expect(bad.code).toBe(1);
		expect(bad.out).toContain(
			'FANGORN_DATA_REGISTRY is not an address: "not-an-address"',
		);
	}, 60_000);
});
