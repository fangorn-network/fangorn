import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { appId } from "../config.js";
import { chainNetwork, type ChainNetwork, skipChain } from "../test/testbed.js";

// The real CLI, run as a user would, against the contracts on anvil: the
// FANGORN_RPC_URL / FANGORN_APP_REGISTRY / FANGORN_DATA_REGISTRY overrides point it
// there, and each user is a HOME of their own, holding ~/.fangorn/config.json.

const ROOT = resolve(import.meta.dirname, "../..");
const TSX = join(ROOT, "node_modules/.bin/tsx");
const CLI = join(ROOT, "src/cli/cli.ts");

interface Run {
	code: number;
	out: string;
}

describe.skipIf(skipChain)("CLI app commands (contracts on anvil)", () => {
	let net: ChainNetwork;
	const homes: string[] = [];

	beforeAll(async () => {
		net = await chainNetwork();
	}, 120_000);
	afterAll(() => {
		net.stop();
		for (const home of homes) rmSync(home, { recursive: true, force: true });
	});

	/** A user with a funded wallet and a config file choosing `app`. */
	async function user(app: string) {
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
				appId: app,
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
					FANGORN_APP_REGISTRY: net.config.appRegistryContractAddress,
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
		const storedApp = () =>
			(JSON.parse(readFileSync(configPath, "utf-8")) as { appId?: string })
				.appId;
		return { run, storedApp };
	}

	it("renames the configured app, and the config file follows it", async () => {
		const owner = await user("cli-before");
		expect((await owner.run(["app", "claim"])).code).toBe(0);

		const renamed = await owner.run(["app", "rename", "cli-after"]);
		expect(renamed).toMatchObject({ code: 0 });
		expect(renamed.out).toContain(`App id:     ${appId("cli-after")}`);
		expect(renamed.out).toContain(`Claimed as: ${appId("cli-before")}`);
		expect(owner.storedApp()).toBe("cli-after");

		// Under the new name: the app, and where it was claimed.
		const info = await owner.run(["app", "info"]);
		expect(info).toMatchObject({ code: 0 });
		expect(info.out).toContain(`App id:     ${appId("cli-after")}`);
		expect(info.out).toContain(`Claimed as: ${appId("cli-before")}`);
		expect(info.out).toContain("(you)");
		expect(info.out).toMatch(/This app:\s+accepted/);

		// Under the old name, which still works: where the app went.
		const old = await owner.run(["--app", "cli-before", "app", "info"]);
		expect(old).toMatchObject({ code: 0 });
		expect(old.out).toContain(`Renamed to: ${appId("cli-after")}`);
		expect(old.out).toContain("(you)");

		// The current id typed in capitals is still the current id.
		const upper = `0x${appId("cli-after").slice(2).toUpperCase()}`;
		const typed = await owner.run(["--app", upper, "app", "info"]);
		expect(typed).toMatchObject({ code: 0 });
		expect(typed.out).not.toContain("Renamed to:");
	}, 180_000);

	it("leaves the config file alone when the app came from an override", async () => {
		const owner = await user("cli-stored");
		expect((await owner.run(["app", "claim"])).code).toBe(0);

		const viaEnv = await owner.run(["app", "rename", "cli-env"], {
			FANGORN_APP_ID: "cli-stored",
		});
		expect(viaEnv).toMatchObject({ code: 0 });
		expect(viaEnv.out).toContain(
			'The app came from FANGORN_APP_ID: update it to "cli-env"',
		);
		expect(owner.storedApp()).toBe("cli-stored");

		const viaFlag = await owner.run([
			"--app",
			"cli-env",
			"app",
			"rename",
			"cli-flag",
		]);
		expect(viaFlag).toMatchObject({ code: 0 });
		expect(viaFlag.out).toContain(
			'The app came from --app: update it to "cli-flag"',
		);
		expect(owner.storedApp()).toBe("cli-stored");
	}, 180_000);

	it("refuses a stranger's rename, a taken name, and an unclaimed app", async () => {
		const owner = await user("cli-mine");
		expect((await owner.run(["app", "claim"])).code).toBe(0);
		const other = await user("cli-theirs");
		expect((await other.run(["app", "claim"])).code).toBe(0);

		const taken = await owner.run(["app", "rename", "cli-theirs"]);
		expect(taken.code).toBe(1);
		expect(taken.out).toContain("is already another app's");
		expect(owner.storedApp()).toBe("cli-mine");

		const stranger = await other.run([
			"--app",
			"cli-mine",
			"app",
			"rename",
			"cli-stolen",
		]);
		expect(stranger.code).toBe(1);
		expect(stranger.out).toContain("only its owner can rename it");

		const unclaimed = await owner.run([
			"--app",
			"cli-nobodys",
			"app",
			"rename",
			"cli-anything",
		]);
		expect(unclaimed.code).toBe(1);
		expect(unclaimed.out).toContain("is unclaimed");
	}, 180_000);

	it("rejects an override that is not an address", async () => {
		const owner = await user("cli-bad-env");
		const bad = await owner.run(["app", "info"], {
			FANGORN_APP_REGISTRY: "not-an-address",
		});
		expect(bad.code).toBe(1);
		expect(bad.out).toContain(
			'FANGORN_APP_REGISTRY is not an address: "not-an-address"',
		);
	}, 60_000);
});
