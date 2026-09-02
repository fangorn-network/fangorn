#!/usr/bin/env node
import { Command } from "commander";
import { intro, outro, text, spinner, confirm } from "@clack/prompts";
import {
	createPublicClient,
	formatEther,
	http,
	type Address,
	type Hex,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	chmodSync,
} from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import "dotenv/config";

import { Fangorn } from "../fangorn.js";
import { handleCancel } from "./index.js";
import { AppConfig, DEFAULT_APP, FangornConfig, toAppId } from "../config.js";
import { StorageConfig } from "../types/index.js";
import {
	needsReacceptance,
	PublisherStatus,
	type AppJoinInfo,
} from "../contracts/index.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface StoredConfig {
	privateKey: Hex;
	chainName: string;
	pinataJwt: string;
	pinataGateway: string;
	// Gates access to content (does this user meet the access requirements).
	// Optional — unset means no access-gating worker is configured. Also absent
	// from configs written before these two workers were split apart.
	accessWorkerUrl?: string;
	// The pinata-url-provider worker that distributes presigned upload URLs.
	// Required only when uploading via signed URLs (no own Pinata JWT).
	signedUrlWorkerUrl?: string;
	// The app (global namespace) commands run under — a name or a 32-byte app id.
	// Set with `fangorn set-app`; unset means the SDK default.
	appId?: string;
}

interface Config {
	privateKey: Hex;
	cfg: AppConfig;
	// The app the user actually chose (env, config file, or `--app`), if any.
	// Left undefined since naming an app bills uploads to that
	// app owner's storage subscription. We do not want `fangorn` to be filled in on the user's
	// behalf. `currentAppName()` applies the default for display and namespace keys.
	appId?: string;
	pinataJwt: string;
	pinataGateway: string;
	accessWorkerUrl: string;
	signedUrlWorkerUrl: string;
}

/** JSON commit input: a namespace's vertices and (optionally) the edges between them. */
interface CommitFile {
	vertices: { id: string; tag: string; payload: Record<string, unknown> }[];
	edges?: { rel: string; from: string; to: string }[];
}

// ─── Global config (credentials) ────────────────────────────────────────────────

const CONFIG_DIR = join(homedir(), ".fangorn");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

let _config: Config | null = null;
let _account: PrivateKeyAccount | null = null;
let _fangorn: Fangorn | null = null;

function readStoredConfig(): StoredConfig {
	return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as StoredConfig;
}

function writeStoredConfig(stored: StoredConfig): void {
	if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
	writeFileSync(CONFIG_PATH, JSON.stringify(stored, null, 2), "utf-8");
	chmodSync(CONFIG_PATH, 0o600);
}

function loadConfig(): Config {
	if (_config) return _config;

	const privateKey = process.env.ETH_PRIVATE_KEY;
	const pinataJwt = process.env.PINATA_JWT;
	const pinataGateway = process.env.PINATA_GATEWAY;
	const accessWorkerUrl = process.env.ACCESS_WORKER_URL;
	const signedUrlWorkerUrl = process.env.SIGNED_URL_WORKER_URL;
	// Blank counts as unset, so an exported-but-empty FANGORN_APP_ID (common in
	// Docker/CI) falls through to the stored app instead of overriding it with an
	// app called "". `??` would not catch it — "" is not nullish.
	const envAppId = process.env.FANGORN_APP_ID?.trim() || undefined;

	if (existsSync(CONFIG_PATH)) {
		const stored = readStoredConfig();
		_config = {
			privateKey: stored.privateKey,
			cfg: FangornConfig,
			appId: envAppId ?? (stored.appId?.trim() || undefined),
			pinataJwt: stored.pinataJwt,
			pinataGateway: stored.pinataGateway,
			accessWorkerUrl: stored.accessWorkerUrl ?? "",
			signedUrlWorkerUrl: stored.signedUrlWorkerUrl ?? "",
		};
		return _config;
	}

	if (privateKey || pinataJwt || pinataGateway || signedUrlWorkerUrl) {
		// Only the wallet is required: with no Pinata JWT, uploads fall back to
		// signed URLs from the hosted presigned-URL worker.
		if (!privateKey) {
			throw new Error(
				"Incomplete environment configuration. Missing: ETH_PRIVATE_KEY\n" +
				"Set it or run `fangorn init` to use a config file.",
			);
		}

		_config = {
			privateKey: privateKey as Hex,
			cfg: FangornConfig,
			appId: envAppId,
			pinataJwt: pinataJwt ?? "",
			pinataGateway: pinataGateway ?? "",
			accessWorkerUrl: accessWorkerUrl ?? "",
			signedUrlWorkerUrl: signedUrlWorkerUrl ?? "",
		};

		return _config;
	}

	throw new Error(
		"No configuration found. Run `fangorn init` or set ETH_PRIVATE_KEY\n" +
		"(with no config, uploads go to Fangorn's shared Pinata account; files may be unpinned without notice. Set PINATA_JWT + PINATA_GATEWAY to use your own storage).",
	);
}

function getAccount(): PrivateKeyAccount {
	if (_account) return _account;
	_account = privateKeyToAccount(loadConfig().privateKey);
	return _account;
}

function getFangorn(): Fangorn {
	if (_fangorn) return _fangorn;

	const cfg = loadConfig();

	// Prefer the user's own JWT when present; otherwise upload via signed URLs
	// from the presigned-URL worker (no JWT needed). Either way the configured
	// gateway applies: uploads go wherever the backend sends them, but reads always
	// resolve by CID through a gateway, and the default (ipfs.io) is unreachable on
	// networks whose DNS filters public IPFS gateways. Blank stays on the default.
	const storage: StorageConfig = cfg.pinataJwt
		? { pinata: { jwt: cfg.pinataJwt, gateway: cfg.pinataGateway } }
		: {
			signedUrl: {
				workerUrl: cfg.signedUrlWorkerUrl,
				gateway: cfg.pinataGateway,
			},
		};

	_fangorn = Fangorn.create({
		privateKey: cfg.privateKey,
		storage,
		domain: "localhost",
		config: cfg.cfg,
		// `--app` (global option) wins over the stored app for this invocation.
		appId: appFlag() ?? cfg.appId,
	});
	return _fangorn;
}

/** The `--app` override for this invocation; blank counts as unset. */
function appFlag(): string | undefined {
	return (program.opts().app as string | undefined)?.trim() || undefined;
}

/**
 * The currently configured app name
 */
function currentAppName(): string {
	return appFlag() ?? loadConfig().appId ?? DEFAULT_APP;
}

// ─── Local repo (working-directory ref) ─────────────────────────────────────────
//
// local state of a fangorn 'repo' (a git-native style repo)
interface RepoState {
	namespace: string;
	owner: Address;
	head: string | null;
}

class LocalRepo {
	private constructor(
		private readonly dir: string,
		private state: RepoState,
	) { }

	private static path(dir: string): string {
		return join(dir, ".fangorn", "repo.json");
	}

	/** Create (or overwrite) a repo pointer in `dir`. */
	static init(state: RepoState, dir: string = process.cwd()): LocalRepo {
		const repoDir = join(dir, ".fangorn");
		if (!existsSync(repoDir)) mkdirSync(repoDir, { recursive: true });
		const repo = new LocalRepo(dir, state);
		repo.save();
		return repo;
	}

	/** Open the repo containing `dir` (searches upward like git). Throws if none. */
	static open(dir: string = process.cwd()): LocalRepo {
		let cur = dir;
		let parent = "";

		while (cur !== parent) {
			const p = LocalRepo.path(cur);
			if (existsSync(p)) {
				return new LocalRepo(
					cur,
					JSON.parse(readFileSync(p, "utf-8")) as RepoState,
				);
			}

			parent = cur;
			cur = dirname(cur);
		}

		throw new Error(
			"not a fangorn repo (no .fangorn/repo.json here or above). Run `fangorn repo init <namespace>` or `fangorn clone`.",
		);
	}

	private save(): void {
		writeFileSync(
			LocalRepo.path(this.dir),
			JSON.stringify(this.state, null, 2),
			"utf-8",
		);
	}

	namespace(): string {
		return this.state.namespace;
	}
	owner(): Address {
		return this.state.owner;
	}
	head(): string | null {
		return this.state.head;
	}

	setHead(cid: string | null): void {
		this.state.head = cid;
		this.save();
	}
}

// ─── CLI root ─────────────────────────────────────────────────────────────────

const program = new Command();
const ZERO_HASH = `0x${"0".repeat(64)}` as const;

// Placeholder terms for `fangorn app claim`, which has no document to hash.
// Deliberately NOT the zero hash: zero means "this app has published no terms" and
// makes the app unjoinable. This is a recognisable stand-in the owner is expected to
// replace with `setAppTerms(sha256(terms), uri)` before inviting publishers — and
// because joining pins the exact hash accepted, anyone who joined against the
// placeholder must re-accept once the real terms land.
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

const APP_TERMS_PLACEHOLDER =
	"0x0000000000000000000000000000000000000000000000000000000000000001" as const;

program.name("fangorn").description("Fangorn Network CLI").version("0.4.0");
// The app id decides which global namespace a command reads from and publishes into, overrides set-app
program.option(
	"--app <name-or-id>",
	"App (global namespace) for this command — overrides the stored app (see `set-app`)",
);

/// initialize the fangorn cli
program
	.command("init")
	.description("Configure your Fangorn credentials")
	.action(async () => {
		intro("Fangorn Setup");

		const privateKey = await text({
			message: "Wallet private key (stored locally, never transmitted):",
			placeholder: "0x...",
			validate: (v) => {
				if (!v) return "Required";
				if (!v.startsWith("0x") || v.length !== 66)
					return "Must be a valid 0x-prefixed 32-byte hex key";
			},
		});
		handleCancel(privateKey);

		// Storage: either your own Pinata JWT + gateway, or the access worker for
		// signed-url uploads (no JWT). Leave the JWT blank to use signed URLs.
		const pinataJwt = await text({
			message: "Pinata JWT — leave blank to use Fangorn's shared Pinata account (testnet convenience; files may be unpinned without notice):",
		});
		handleCancel(pinataJwt);

		const pinataGateway = await text({
			message: "Pinata Gateway URL (optional; blank uses a public IPFS gateway):",
			placeholder: "https://your-gateway.mypinata.cloud",
		});
		handleCancel(pinataGateway);

		// Access-gating worker: checks whether this user meets the requirements to
		// access content. Optional — leave blank if you don't gate access.
		const accessWorkerUrl = await text({
			message: "Access-gating worker URL (optional):",
			placeholder: "https://access-worker.your-subdomain.workers.dev",
		});
		handleCancel(accessWorkerUrl);

		// Presigned-URL worker (pinata-url-provider): issues short-lived Pinata
		// upload URLs. Optional — blank uses the hosted default, so no JWT is
		// needed to upload via signed URLs.
		const signedUrlWorkerUrl = await text({
			message: "Presigned-URL worker URL (optional; blank uses the hosted default):",
			placeholder: "https://pinata-url-provider.your-subdomain.workers.dev",
		});
		handleCancel(signedUrlWorkerUrl);

		writeStoredConfig({
			privateKey: privateKey as Hex,
			chainName: "Arbitrum Sepolia",
			pinataJwt: pinataJwt as string,
			pinataGateway: pinataGateway as string,
			accessWorkerUrl: accessWorkerUrl as string,
			signedUrlWorkerUrl: signedUrlWorkerUrl as string,
			// Keep whatever `set-app` chose; re-running init shouldn't silently
			// move the user back to the default app.
			appId: existsSync(CONFIG_PATH) ? readStoredConfig().appId : undefined,
		});

		outro(`Config saved to ${CONFIG_PATH}`);
	});

// ─── app (global namespace) ───────────────────────────────────────────────────
//
// The app id prefixes every namespace key, so it decides which global namespace
// commands read from and publish into. It is per-client state, not part of the
// SDK's network config: the CLI persists a choice here, the SDK takes it via
// `Fangorn.create({ appId })` / `fangorn.setAppId()`.

program
	.command("set-app")
	.description(
		"Set the app (global namespace) this CLI publishes and reads under",
	)
	.argument("[app]", "App name or 32-byte app id (omit to show the current one)")
	.action((app: string | undefined) => {
		try {
			if (!app) {
				const current = currentAppName();
				console.log(`App:    ${current}`);
				console.log(`App id: ${toAppId(current)}`);
				process.exit(0);
			}

			if (!existsSync(CONFIG_PATH)) {
				throw new Error(
					`no config file at ${CONFIG_PATH} — run \`fangorn init\` first, or set FANGORN_APP_ID in the environment.`,
				);
			}
			writeStoredConfig({ ...readStoredConfig(), appId: app });

			console.log(`App:    ${app}`);
			console.log(`App id: ${toAppId(app)}`);
			if (process.env.FANGORN_APP_ID) {
				console.log(
					`\nNote: FANGORN_APP_ID=${process.env.FANGORN_APP_ID} is set and overrides this.`,
				);
			}
			// Switching apps changes nothing on-chain: the new app may be
			// unclaimed, or claimed by someone else and not yet joined. Both
			// surface as a revert at push time, so point at `app info` now.
			console.log(
				`\nSaved to ${CONFIG_PATH}. Run \`fangorn app info\` to see whether it is claimed and whether you have joined it.`,
			);
			process.exit(0);
		} catch (err) {
			console.error("Failed:", (err as Error).message);
			process.exit(1);
		}
	});

// ─── app membership ───────────────────────────────────────────────────────────
//
// Two registries, in this order:
//
//   DataRegistry.register()      global standing — "this wallet may publish at all"
//   AppRegistry.registerForApp() per-app membership — "…and under THIS app"
//
// `commitStateRoot` cross-calls the second, so a wallet registered globally but
// not joined to the app gets `NotRegisteredForApp` at push time — far from the
// cause. `fangorn register` does both; `fangorn app info` shows where you stand.

/** The status word for a publisher in one app, and whether they can publish. */
function membershipLine(info: AppJoinInfo): string {
	// An admin takedown outranks everything below: it makes `registered` false for
	// the app's own owner, and telling them to join would be a lie.
	if (info.appSuspended)
		return "the whole app is suspended by the protocol admin — nobody can publish under it";
	if (info.registered) return "joined";
	if (needsReacceptance(info))
		return "terms changed since you joined — run `fangorn app join` to re-accept (free)";
	if (info.status === PublisherStatus.SUSPENDED)
		return "suspended from this app by its owner";
	return "not joined — run `fangorn app join`";
}

const appCmd = program
	.command("app")
	.description("Claim, join and manage apps (global namespaces)");

appCmd
	.command("info")
	.description("Show this app's terms, fee, owner, and where you stand in it")
	.action(async () => {
		try {
			const self = getAccount().address;
			const fangorn = getFangorn();
			const apps = fangorn.getAppRegistry();
			const data = fangorn.getDataRegistry();
			const s = spinner();

			s.start("Reading registries...");
			const [owner, info, registeredGlobally] = await Promise.all([
				apps.getAppOwner(),
				apps.joinInfo(self),
				data.isRegistered(self),
			]);
			s.stop();

			console.log(`App:        ${currentAppName()}`);
			console.log(`App id:     ${apps.getAppId()}`);

			if (owner === ZERO_ADDRESS) {
				console.log(`Owner:      (unclaimed — \`fangorn app claim\` takes it)`);
			} else {
				console.log(
					`Owner:      ${owner}${owner.toLowerCase() === self.toLowerCase() ? "  (you)" : ""}`,
				);
				console.log(`Terms:      ${info.termsHash}`);
				if (info.termsUri) console.log(`Terms uri:  ${info.termsUri}`);
				console.log(`Join fee:   ${info.fee.toString()} wei`);
			}

			if (info.appSuspended)
				console.log(`Status:     SUSPENDED by the protocol admin`);

			console.log(`\nWallet:     ${self}`);
			console.log(
				`DataRegistry: ${registeredGlobally ? "registered" : "not registered — run `fangorn register`"}`,
			);
			console.log(`This app:     ${owner === ZERO_ADDRESS ? "n/a (unclaimed)" : membershipLine(info)}`);
			process.exit(0);
		} catch (err) {
			console.error("Failed:", (err as Error).message);
			process.exit(1);
		}
	});

appCmd
	.command("claim")
	.description("Claim the configured app on-chain (first come, first served)")
	.option(
		"--terms-hash <hash>",
		"32-byte hash of your terms document (default: a placeholder you should replace)",
	)
	.option("--terms-uri <uri>", "Where the terms document lives", "")
	.option("--fee <wei>", "What joining this app costs, in wei", "0")
	.action(async (opts: { termsHash?: string; termsUri: string; fee: string }) => {
		try {
			const self = getAccount().address;
			const registry = getFangorn().getAppRegistry();
			const s = spinner();

			s.start("Checking app ownership...");
			const owner = await registry.getAppOwner();
			s.stop();

			// Apps are first come, first served — claiming a taken one reverts.
			if (owner !== ZERO_ADDRESS) {
				const mine = owner.toLowerCase() === self.toLowerCase();
				console.log(
					mine
						? `Already claimed by you: ${registry.getAppId()}`
						: `App ${registry.getAppId()} is already owned by ${owner}. Pick another name with \`fangorn set-app\`, or join this one with \`fangorn app join\`.`,
				);
				process.exit(mine ? 0 : 1);
			}

			const termsHash = (opts.termsHash ?? APP_TERMS_PLACEHOLDER) as Hex;
			s.start("Claiming app...");
			const txHash = await registry.registerApp(
				termsHash,
				opts.termsUri,
				BigInt(opts.fee),
			);
			s.stop();

			console.log(`App:    ${currentAppName()}`);
			console.log(`App id: ${registry.getAppId()}`);
			console.log(`Owner:  ${self}`);
			console.log(`Terms:  ${termsHash}`);
			console.log(`Tx:     ${txHash}`);
			if (!opts.termsHash) {
				console.log(
					`\nThose are placeholder terms. Publish real ones with \`fangorn app terms <hash> <uri>\` —` +
					`\nanyone who joined against the placeholder must then re-accept.`,
				);
			}
			console.log(`\nClaiming makes you your own first publisher; run \`fangorn register\` for global standing.`);
			process.exit(0);
		} catch (err) {
			console.error("Failed:", (err as Error).message);
			process.exit(1);
		}
	});

appCmd
	.command("join")
	.description("Join the configured app, accepting its current terms")
	.action(async () => {
		try {
			const self = getAccount().address;
			const registry = getFangorn().getAppRegistry();
			const s = spinner();

			s.start("Reading terms...");
			const info = await registry.joinInfo(self);
			s.stop();

			if (info.registered) {
				console.log(`Already joined ${registry.getAppId()} as ${self}`);
				process.exit(0);
			}
			// A zero terms hash means the app was never claimed (or its owner never
			// set terms) — there is nothing to accept, and the client would throw
			// only after the user had already confirmed.
			if (info.termsHash === ZERO_HASH) {
				console.error(
					`App ${registry.getAppId()} has published no terms — it cannot be joined.` +
					`\nIf it is unclaimed, \`fangorn app claim\` takes it; otherwise its owner must set terms.`,
				);
				process.exit(1);
			}
			if (info.status === PublisherStatus.SUSPENDED) {
				console.error(
					`Suspended from this app by its owner — joining again will revert. Ask them to reinstate you.`,
				);
				process.exit(1);
			}
			if (info.appSuspended) {
				console.error(
					`App ${registry.getAppId()} has been suspended by the protocol admin — joining will revert.`,
				);
				process.exit(1);
			}

			// Joining pins the exact hash read here, so terms cannot move under a
			// pending join and land as agreement to something else.
			console.log(`Terms:     ${info.termsHash}`);
			if (info.termsUri) console.log(`Terms uri: ${info.termsUri}`);
			console.log(`Join fee:  ${info.fee.toString()} wei`);

			const ok = await confirm({
				message: needsReacceptance(info)
					? "The terms changed since you joined. Accept the new ones?"
					: "Accept these terms and join?",
			});
			handleCancel(ok);
			if (!ok) process.exit(0);

			s.start("Joining app...");
			const txHash = await registry.registerForApp();
			s.stop();

			console.log(`Joined: ${registry.getAppId()}`);
			console.log(`Tx:     ${txHash}`);
			process.exit(0);
		} catch (err) {
			console.error("Failed:", (err as Error).message);
			process.exit(1);
		}
	});

appCmd
	.command("terms")
	.description("Publish new terms for your app (owner only)")
	.argument("<hash>", "32-byte hash of the terms document")
	.argument("[uri]", "Where the document lives", "")
	.action(async (hash: string, uri: string) => {
		try {
			const registry = getFangorn().getAppRegistry();
			// Moving the terms drops every publisher back to "must accept again".
			const ok = await confirm({
				message:
					"New terms unregister every publisher until they re-accept (free). Continue?",
			});
			handleCancel(ok);
			if (!ok) process.exit(0);

			const s = spinner();
			s.start("Publishing terms...");
			const txHash = await registry.setAppTerms(hash as Hex, uri);
			s.stop();
			console.log(`Terms: ${hash}`);
			console.log(`Tx:    ${txHash}`);
			process.exit(0);
		} catch (err) {
			console.error("Failed:", (err as Error).message);
			process.exit(1);
		}
	});

appCmd
	.command("fee")
	.description("Set what joining your app costs, in wei (owner only)")
	.argument("<wei>", "Join fee in wei")
	.action(async (wei: string) => {
		try {
			const s = spinner();
			s.start("Setting join fee...");
			const txHash = await getFangorn().getAppRegistry().setAppFee(BigInt(wei));
			s.stop();
			console.log(`Join fee: ${wei} wei`);
			console.log(`Tx:       ${txHash}`);
			process.exit(0);
		} catch (err) {
			console.error("Failed:", (err as Error).message);
			process.exit(1);
		}
	});

appCmd
	.command("suspend")
	.description("Eject a publisher from your app (owner only)")
	.argument("<publisher>", "Publisher address")
	.action(async (publisher: string) => {
		try {
			const s = spinner();
			s.start("Suspending publisher...");
			const txHash = await getFangorn()
				.getAppRegistry()
				.suspendForApp(publisher as Address);
			s.stop();
			// Per-app only: their global standing and other apps are untouched.
			console.log(`Suspended: ${publisher}`);
			console.log(`Tx:        ${txHash}`);
			process.exit(0);
		} catch (err) {
			console.error("Failed:", (err as Error).message);
			process.exit(1);
		}
	});

appCmd
	.command("reinstate")
	.description("Reinstate a suspended publisher in your app (owner only)")
	.argument("<publisher>", "Publisher address")
	.action(async (publisher: string) => {
		try {
			const s = spinner();
			s.start("Reinstating publisher...");
			const txHash = await getFangorn()
				.getAppRegistry()
				.reinstateForApp(publisher as Address);
			s.stop();
			console.log(`Reinstated: ${publisher}`);
			console.log(`Tx:         ${txHash}`);
			process.exit(0);
		} catch (err) {
			console.error("Failed:", (err as Error).message);
			process.exit(1);
		}
	});

// ─── app admin (protocol admin) ────────────────────────────────────────────────
//
// A level above the app owner: `app suspend` ejects one publisher from one app,
// `app admin suspend` takes the whole app down, its owner included. The
// memberships underneath survive, so a reinstatement restores the app exactly as
// it was rather than making everyone pay to join again.

const appAdminCmd = appCmd
	.command("admin")
	.description("Protocol-admin takedowns for the whole app (admin only)");

/** The AppRegistry client, refusing early if this wallet is not the protocol admin. */
async function requireAdmin() {
	const registry = getFangorn().getAppRegistry();
	const self = getAccount().address;
	const admin = await registry.admin();
	if (admin.toLowerCase() !== self.toLowerCase()) {
		// Otherwise the only feedback is an `Unauthorized` revert after gas.
		throw new Error(
			`Not the protocol admin: this registry's admin is ${admin}, you are ${self}.`,
		);
	}
	return registry;
}

appAdminCmd
	.command("suspend")
	.description("Suspend this entire app — nobody can publish under it (admin only)")
	.action(async () => {
		try {
			const registry = await requireAdmin();

			const ok = await confirm({
				message: `Suspend the whole app ${registry.getAppId()}? Every publisher, including its owner, stops being registered.`,
			});
			handleCancel(ok);
			if (!ok) process.exit(0);

			const s = spinner();
			s.start("Suspending app...");
			const txHash = await registry.suspendApp();
			s.stop();
			console.log(`Suspended: ${registry.getAppId()}`);
			console.log(`Tx:        ${txHash}`);
			console.log(
				`\nMemberships are kept — \`fangorn app admin reinstate\` restores them as they were.`,
			);
			process.exit(0);
		} catch (err) {
			console.error("Failed:", (err as Error).message);
			process.exit(1);
		}
	});

appAdminCmd
	.command("reinstate")
	.description("Lift the suspension on this entire app (admin only)")
	.action(async () => {
		try {
			const registry = await requireAdmin();
			const s = spinner();
			s.start("Reinstating app...");
			const txHash = await registry.reinstateApp();
			s.stop();
			console.log(`Reinstated: ${registry.getAppId()}`);
			console.log(`Tx:         ${txHash}`);
			process.exit(0);
		} catch (err) {
			console.error("Failed:", (err as Error).message);
			process.exit(1);
		}
	});

appAdminCmd
	.command("status")
	.description("Who the protocol admin is, and whether this app is suspended")
	.action(async () => {
		try {
			const registry = getFangorn().getAppRegistry();
			const self = getAccount().address;
			const s = spinner();
			s.start("Reading registry...");
			const [admin, suspended] = await Promise.all([
				registry.admin(),
				registry.isAppSuspended(),
			]);
			s.stop();
			console.log(`App id:    ${registry.getAppId()}`);
			console.log(
				`Admin:     ${admin}${admin.toLowerCase() === self.toLowerCase() ? "  (you)" : ""}`,
			);
			console.log(`Suspended: ${suspended ? "yes — nobody can publish under this app" : "no"}`);
			process.exit(0);
		} catch (err) {
			console.error("Failed:", (err as Error).message);
			process.exit(1);
		}
	});

// Kept so existing scripts and docs keep working; `app claim` is the real one.
program
	.command("register-app", { hidden: true })
	.description("Deprecated alias for `fangorn app claim`")
	.action(() => {
		console.error("`register-app` is now `fangorn app claim`.");
		process.exit(1);
	});

// ─── register (publisher registration) ─────────────────────────────────────────

program
	.command("register")
	.description("Register as a publisher: global standing, then join this app")
	.action(async () => {
		try {
			const self = getAccount().address;
			const fangorn = getFangorn();
			const data = fangorn.getDataRegistry();
			const apps = fangorn.getAppRegistry();
			const s = spinner();

			// 1. Global standing in the DataRegistry.
			s.start("Checking publisher registration...");
			const already = await data.isRegistered(self);
			s.stop();

			if (already) {
				console.log(`DataRegistry: already registered`);
			} else {
				s.start("Registering publisher...");
				const txHash = await data.register();
				s.stop();
				console.log(`DataRegistry: registered (tx ${txHash})`);
			}

			// 2. Membership of the app this CLI is pointed at. Without it every
			// push reverts NotRegisteredForApp, so doing only step 1 is a trap.
			s.start("Checking app membership...");
			const owner = await apps.getAppOwner();
			if (owner === ZERO_ADDRESS) {
				s.stop();
				console.log(
					`This app:     ${apps.getAppId()} is unclaimed — nothing to join yet.` +
					`\n              Claim it with \`fangorn app claim\`, or point elsewhere with \`fangorn set-app\`.`,
				);
				process.exit(0);
			}

			const info = await apps.joinInfo(self);
			s.stop();

			if (info.registered) {
				console.log(`This app:     already joined`);
				process.exit(0);
			}
			if (info.status === PublisherStatus.SUSPENDED) {
				console.error(`This app:     suspended by the app owner — cannot join.`);
				process.exit(1);
			}

			s.start(needsReacceptance(info) ? "Re-accepting terms..." : "Joining app...");
			const joinTx = await apps.registerForApp();
			s.stop();
			console.log(
				`This app:     joined ${apps.getAppId()} (tx ${joinTx}, fee ${info.fee.toString()} wei)`,
			);
			console.log(`\nPublisher: ${self}`);
			process.exit(0);
		} catch (err) {
			console.error("Failed:", (err as Error).message);
			process.exit(1);
		}
	});

// ─── wallet ───────────────────────────────────────────────────────────────────

program
	.command("wallet")
	.description("Show the wallet this CLI signs with")
	.argument("[action]", "show", "show")
	.option(
		"--reveal",
		"Also print the PRIVATE key — it grants full control of this wallet",
	)
	.action(async (_action: string, opts: { reveal?: boolean }) => {
		try {
			const cfg = loadConfig();
			const account = getAccount();
			const s = spinner();

			s.start("Reading balance...");
			const publicClient = createPublicClient({ transport: http(cfg.cfg.rpcUrl) });
			const balance = await publicClient.getBalance({ address: account.address });
			s.stop();

			console.log(`Address:     ${account.address}`);
			console.log(`Public key:  ${account.publicKey}`);
			console.log(`Balance:     ${formatEther(balance)} ETH`);
			console.log(`Network:     ${cfg.cfg.chain.name} (${cfg.cfg.caip2.toString()})`);
			console.log(`App:         ${currentAppName()}`);
			console.log(`Config:      ${existsSync(CONFIG_PATH) ? CONFIG_PATH : "(from environment)"}`);

			// Printing a key to a terminal puts it in scrollback, shell logs and any
			// screen share, so it takes an explicit flag — never the default output.
			if (opts.reveal) {
				console.log(`\nPrivate key: ${cfg.privateKey}`);
				console.log(`Anyone with that key controls this wallet. Do not share it.`);
			} else {
				console.log(`\nPrivate key: hidden — pass --reveal to print it`);
			}
			process.exit(0);
		} catch (err) {
			console.error("Failed:", (err as Error).message);
			process.exit(1);
		}
	});

const repoCmd = program.command("repo").description("Repository operations");

// track an app instead of namespace?
repoCmd
	.command("init")
	.description("Start tracking a namespace here (allocates it on-chain if new)")
	.argument("<namespace>", "Namespace name")
	.action(async (namespace: string) => {
		try {
			const fangorn = getFangorn();
			const owner = fangorn.getAddress();
			const s = spinner();
			s.start(`Initializing namespace "${namespace}"...`);
			const result = await fangorn.initRepo(namespace);
			// Whether we just created it or it already existed, HEAD tracks the on-chain tip.
			const head = result.alreadyInitialized ? await fangorn.onChainTip(owner, namespace) : result.commitCid;
			const repo = LocalRepo.init({ namespace, owner, head });
			s.stop();

			if (result.alreadyInitialized) {
				console.log(
					`Namespace "${namespace}" already exists for ${owner}. Tracking it here.`,
				);
			} else {
				console.log(`Namespace: ${namespace}`);
				console.log(`Owner:     ${owner}`);
				console.log(`Tx:        ${result.txHash}`);
			}
			console.log(`HEAD:      ${repo.head() ?? "(none)"}`);
			process.exit(0);
		} catch (err) {
			console.error("Failed:", (err as Error).message);
			process.exit(1);
		}
	});

program
	.command("commit")
	.description(
		"Snapshot a namespace's vertices/edges into a new local commit (does not push)",
	)
	.argument(
		"<file>",
		'JSON file: {"vertices":[{"id","tag","payload"}],"edges":[{"rel","from","to"}]}',
	)
	.requiredOption("-m, --message <msg>", "Commit message")
	.option(
		"--replace",
		"Snapshot semantics: the file replaces the namespace's previous contents (omitted entries are removed)",
	)
	.action(
		async (file: string, options: { message: string; replace?: boolean }) => {
			try {
				if (!existsSync(file)) throw new Error(`file not found: ${file}`);
				const data = JSON.parse(readFileSync(file, "utf-8")) as CommitFile;
				if (!Array.isArray(data.vertices) || data.vertices.length === 0) {
					throw new Error(`${file} must contain a non-empty "vertices" array`);
				}

				const repo = LocalRepo.open();
				const fangorn = getFangorn();
				const parent = repo.head() ?? undefined;
				const s = spinner();
				s.start(
					parent
						? "Committing (building on local HEAD)..."
						: "Committing (initial)...",
				);
				const result = await fangorn.commit({
					namespace: repo.namespace(),
					vertices: data.vertices,
					edges: data.edges ?? [],
					parent,
					message: options.message,
					replace: options.replace,
				});
				s.stop();
				repo.setHead(result.commitCid);

				console.log(`Commit:  ${result.commitCid}`);
				console.log(`Parent:  ${result.parents[0] ?? "(root)"}`);
				console.log(`Tree:    ${result.root}`);
				console.log(
					`Staged:  ${data.vertices.length.toString()} vertice(s) / ${(data.edges ?? []).length.toString()} edge(s)`,
				);
				console.log(`Message: ${options.message}`);
				console.log(
					`\nCommitted locally. Run \`fangorn push\` to settle it on-chain.`,
				);
				process.exit(0);
			} catch (err) {
				console.error("Failed:", (err as Error).message);
				process.exit(1);
			}
		},
	);

program
	.command("push")
	.description(
		"Settle the local tip commit as the on-chain state root (the permissioned step)",
	)
	.option("--force", "Push even if it does not fast-forward the on-chain tip")
	.action(async (options: { force?: boolean }) => {
		try {
			const repo = LocalRepo.open();
			const head = repo.head();
			if (!head) throw new Error("nothing to push — no commits yet");
			const fangorn = getFangorn();
			const s = spinner();

			s.start("Pushing...");
			const { txHash, onChainTip } = await fangorn.push(
				repo.namespace(),
				head,
				{ force: options.force },
			);
			s.stop();

			console.log(`Tx:  ${txHash}`);
			console.log(`Tip: ${onChainTip}`);
			process.exit(0);
		} catch (err) {
			console.error("Failed:", (err as Error).message);
			process.exit(1);
		}
	});

program
	.command("status")
	.description("Compare the local tip with the on-chain tip")
	.action(async () => {
		try {
			const repo = LocalRepo.open();
			const fangorn = getFangorn();
			const localHead = repo.head();
			const onChainTip = await fangorn.onChainTip(
				repo.owner(),
				repo.namespace(),
			);

			const state =
				localHead === onChainTip
					? "up to date"
					: localHead && !onChainTip
						? "local commits not yet pushed"
						: localHead !== onChainTip
							? "local tip differs from on-chain tip (push to fast-forward)"
							: "no local commits";

			console.log(`Namespace:    ${repo.namespace()}`);
			console.log(`Owner:        ${repo.owner()}`);
			console.log(`Local HEAD:   ${localHead ?? "(none)"}`);
			console.log(`On-chain tip: ${onChainTip ?? "(none)"}`);
			console.log(`Status:       ${state}`);
			process.exit(0);
		} catch (err) {
			console.error("Failed:", (err as Error).message);
			process.exit(1);
		}
	});

program
	.command("log")
	.description("Walk commit history from the local tip")
	.option("-n, --max <n>", "Limit number of commits", (v) => parseInt(v, 10))
	.action(async (options: { max?: number }) => {
		try {
			const repo = LocalRepo.open();
			const head = repo.head();
			if (!head) {
				console.log("(no commits yet)");
				process.exit(0);
			}
			const fangorn = getFangorn();

			for await (const c of fangorn.log(head, options.max)) {
				console.log(`commit ${c.cid}`);
				console.log(`Date:   ${new Date(c.timestamp).toISOString()}`);
				console.log(`Tree:   ${c.root}`);
				console.log(`\n    ${c.message}\n`);
			}
			process.exit(0);
		} catch (err) {
			console.error("Failed:", (err as Error).message);
			process.exit(1);
		}
	});

program
	.command("show")
	.description("Show a commit and what it changed vs. its parent")
	.argument("[commit]", "Commit CID (default: local HEAD)")
	.action(async (commitArg: string | undefined) => {
		try {
			const repo = LocalRepo.open();
			const target = commitArg ?? repo.head();
			if (!target) throw new Error("no commit to show — no commits yet");
			const fangorn = getFangorn();

			const diff = await fangorn.show(target);
			console.log(`commit ${target}`);
			console.log(`Date:    ${new Date(diff.timestamp).toISOString()}`);
			console.log(
				`Parents: ${diff.parents.length ? diff.parents.join(", ") : "(root)"}`,
			);
			console.log(`Tree:    ${diff.root}`);
			console.log(`\n    ${diff.message}\n`);
			console.log(
				`Changes vs. parent:  +${diff.added.length.toString()} / -${diff.removed.length.toString()} key(s)`,
			);
			for (const k of diff.added) console.log(`  + ${k}`);
			for (const k of diff.removed) console.log(`  - ${k}`);
			process.exit(0);
		} catch (err) {
			console.error("Failed:", (err as Error).message);
			process.exit(1);
		}
	});

program
	.command("clone")
	.description(
		"Track an existing on-chain namespace by reconstructing its tip locally",
	)
	.argument("<owner>", "Owner (publisher) address")
	.argument("<namespace>", "Namespace name")
	.option(
		"--dir <path>",
		"Directory to create the repo in (default: current dir)",
	)
	.action(
		async (owner: Address, namespace: string, options: { dir?: string }) => {
			try {
				const fangorn = getFangorn();
				const s = spinner();
				s.start(`Resolving on-chain tip for ${owner}...`);
				const tip = await fangorn.onChainTip(owner, namespace);
				const repo = LocalRepo.init(
					{ namespace, owner, head: tip },
					options.dir ?? process.cwd(),
				);
				s.stop();

				console.log(`Namespace: ${namespace}`);
				console.log(`Owner:     ${owner}`);
				console.log(
					`HEAD:      ${repo.head() ?? "(none — publisher has no commits yet)"}`,
				);
				process.exit(0);
			} catch (err) {
				console.error("Failed:", (err as Error).message);
				process.exit(1);
			}
		},
	);

program
	.command("subscribe")
	.description(
		"Watch on-chain pushes to a namespace and stream JSON diffs (light client — no indexer)",
	)
	.argument("[namespace]", "Namespace name (default: current repo)")
	.option(
		"--owner <address>",
		"Owner (publisher) address (default: current repo owner, else self)",
	)
	.option(
		"--from-block <n>",
		"Replay from this block (overrides the saved cursor)",
		(v) => BigInt(v),
	)
	.option(
		"--from-start",
		"Replay this namespace's full history (ignore the saved cursor)",
	)
	.option("--pretty", "Pretty-print each change")
	.option(
		"--all",
		"Watch the whole app (every publisher, every namespace); --owner/namespace narrow it",
	)
	.action(
		async (
			namespaceArg: string | undefined,
			options: {
				owner?: Address;
				fromBlock?: bigint;
				fromStart?: boolean;
				pretty?: boolean;
				all?: boolean;
			},
		) => {
			try {
				const fangorn = getFangorn();

				// Namespace/owner: explicit args win, else fall back to a local repo.
				// In --app mode both are optional filters, so no repo fallback and no
				// self-owner default — an omitted one means "every one of them".
				let namespace = namespaceArg;
				let owner = options.owner;
				if (!options.all) {
					if (!namespace || !owner) {
						try {
							const repo = LocalRepo.open();
							namespace = namespace ?? repo.namespace();
							owner = owner ?? repo.owner();
						} catch {
							/* no repo here — require explicit --owner/namespace */
						}
					}
					if (!namespace)
						throw new Error(
							"namespace required (pass it as an argument, run inside a repo, or use --all)",
						);
					owner = owner ?? fangorn.getAddress();
				}

				// Resume cursor: last fully-processed block, persisted per filter.
				const repoDir = join(process.cwd(), ".fangorn");
				const cursorPath = join(
					repoDir,
					`subscribe-${owner ?? "app"}-${namespace ?? "all"}.json`,
				);
				const readCursor = (): bigint | undefined => {
					// Genesis, not `undefined` — an undefined fromBlock means "live from the
					// current tip", which is the opposite of replaying full history.
					if (options.fromStart) return 0n;
					if (options.fromBlock !== undefined) return options.fromBlock;
					if (existsSync(cursorPath)) {
						const val = JSON.parse(readFileSync(cursorPath, "utf-8")) as { lastBlock?: string | number | bigint };
						const numInput = val.lastBlock ?? 0;
						return BigInt(numInput) + 1n;
					}
					return undefined;
				};
				const writeCursor = (block: bigint) => {
					if (!existsSync(repoDir)) mkdirSync(repoDir, { recursive: true });
					writeFileSync(
						cursorPath,
						JSON.stringify(
							{ owner, namespace, lastBlock: block.toString() },
							null,
							2,
						),
						"utf-8",
					);
				};
				const bigintReplacer = (_k: string, v: unknown) =>
					typeof v === "bigint" ? v.toString() : v;

				const fromBlock = readCursor();
				// Status/logging on stderr so stdout stays a clean JSON-lines stream for piping.
				console.error(
					`Subscribing to "${namespace ?? "*"}" @ ${owner ?? "* (whole app)"} ` +
					(fromBlock !== undefined
						? `from block ${fromBlock.toString()}`
						: "(live from current tip)") +
					` — Ctrl-C to stop.`,
				);

				const controller = new AbortController();
				process.on("SIGINT", () => { controller.abort(); });
				process.on("SIGTERM", () => { controller.abort(); });

				// --all widens the topic filter to the app id; namespace/owner, when given,
				// narrow it back down. Without it the filter is one exact publisher+subspace.
				const stream = options.all
					? fangorn.subscribeApp({
						namespace,
						owner,
						fromBlock,
						signal: controller.signal,
					})
					: fangorn.subscribe({
						namespace: namespace ?? "",
						owner,
						fromBlock,
						signal: controller.signal,
					});

				for await (const change of stream) {
					process.stdout.write(
						JSON.stringify(change, bigintReplacer, options.pretty ? 2 : 0) +
						"\n",
					);
					writeCursor(change.blockNumber);
				}
				process.exit(0);
			} catch (err) {
				console.error("Failed:", (err as Error).message);
				process.exit(1);
			}
		},
	);

program
	.command("read")
	.description(
		"List every vertex and edge committed under a namespace, as JSON",
	)
	.argument("[namespace]", "Namespace name (default: current repo)")
	.option(
		"--owner <address>",
		"Owner (publisher) address (default: current repo owner)",
	)
	.option("--pretty", "Pretty-print the JSON output")
	.action(
		async (
			namespaceArg: string | undefined,
			options: { owner?: Address; pretty?: boolean },
		) => {
			try {
				const fangorn = getFangorn();

				// Fall back to the local repo when namespace/owner aren't given explicitly.
				let namespace = namespaceArg;
				let owner = options.owner;
				if (!namespace || !owner) {
					const repo = LocalRepo.open();
					namespace = namespace ?? repo.namespace();
					owner = owner ?? repo.owner();
				}

				const [head, contents] = await Promise.all([
					fangorn.onChainTip(owner, namespace),
					fangorn.engine.listNamespace(namespace, owner),
				]);

				const out = {
					owner,
					namespace,
					head,
					vertices: contents.vertices,
					edges: contents.edges,
				};
				// write() to a pipe is async: a payload past the OS pipe buffer (~64 KiB on
				// Linux) drains AFTER this returns, so exiting immediately truncates the
				// reader mid-JSON. Exit from the write callback, once the chunk has flushed.
				process.stdout.write(
					JSON.stringify(out, null, options.pretty ? 2 : 0) + "\n",
					() => process.exit(0),
				);
			} catch (err) {
				console.error("Failed:", (err as Error).message);
				process.exit(1);
			}
		},
	);

program
	.command("reset")
	.description(
		"DANGER!: reset this namespace's on-chain head to zero (abandons all prior commits)",
	)
	.action(async () => {
		const namespace = LocalRepo.open().namespace();
		const confirmFirst = await confirm({
			message: `Are you sure? The on-chain head for "${namespace}" will reset to 0x0000...`,
		});
		handleCancel(confirmFirst);
		if (!confirmFirst) {
			console.log("Reset aborted.");
			process.exit(0);
		}

		// If both prompts pass and aren't canceled:
		await getFangorn().reset(namespace);

		console.log(
			`On-chain head for "${namespace}" reset to zero. \`repo init\` will now start fresh.`,
		);
		process.exit(0);
	});

program.parse();
