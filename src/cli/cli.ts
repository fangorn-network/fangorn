#!/usr/bin/env node
import { Command } from "commander";
import { intro, outro, text, spinner, confirm } from "@clack/prompts";
import { type Address, type Hex } from "viem";
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
	appId: string;
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
	const envAppId = process.env.FANGORN_APP_ID;

	if (existsSync(CONFIG_PATH)) {
		const stored = readStoredConfig();
		_config = {
			privateKey: stored.privateKey,
			cfg: FangornConfig,
			// env wins over the saved app, so a one-off run can target another app.
			appId: envAppId ?? stored.appId ?? DEFAULT_APP,
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
			appId: envAppId ?? DEFAULT_APP,
			pinataJwt: pinataJwt ?? "",
			pinataGateway: pinataGateway ?? "",
			accessWorkerUrl: accessWorkerUrl ?? "",
			signedUrlWorkerUrl: signedUrlWorkerUrl ?? "",
		};

		return _config;
	}

	throw new Error(
		"No configuration found. Run `fangorn init` or set ETH_PRIVATE_KEY\n" +
		"(with no config, uploads go to Fangorn's shared Pinata account — a best-effort testnet convenience; files may be unpinned without notice. Set PINATA_JWT + PINATA_GATEWAY to use your own storage).",
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
		appId: cfg.appId,
	});
	return _fangorn;
}

// ─── Local repo (working-directory ref) ─────────────────────────────────────────
//
// The only local state a git-native repo needs: which namespace it tracks, whose
// on-chain root it belongs to, and the commit CID of its local tip (HEAD). Commit
// *objects* themselves live in content-addressed storage — there is no local
// object store to keep in sync, so this is just a pointer file, the analogue of
// `.git/HEAD` + a bit of config.

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
program.name("fangorn").description("Fangorn Network CLI").version("0.4.0");

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
				const current = loadConfig().appId;
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
			console.log(
				`\nSaved to ${CONFIG_PATH}. Run \`fangorn register-app\` if nobody has claimed it yet.`,
			);
			process.exit(0);
		} catch (err) {
			console.error("Failed:", (err as Error).message);
			process.exit(1);
		}
	});

program
	.command("register-app")
	.description("Claim the configured app (global namespace) on-chain")
	.action(async () => {
		try {
			const self = getAccount().address;
			const registry = getFangorn().getDataRegistry();
			const s = spinner();

			s.start("Checking app ownership...");
			const owner = await registry.getAppOwner();
			s.stop();

			// Apps are first come, first served — claiming a taken one reverts.
			if (owner !== "0x0000000000000000000000000000000000000000") {
				console.log(
					owner.toLowerCase() === self.toLowerCase()
						? `Already registered to you: ${registry.getAppId()}`
						: `App ${registry.getAppId()} is already owned by ${owner}. Pick another name with \`fangorn set-app\`.`,
				);
				process.exit(owner.toLowerCase() === self.toLowerCase() ? 0 : 1);
			}

			s.start("Registering app...");
			const txHash = await registry.registerApp();
			s.stop();

			console.log(`App:    ${loadConfig().appId}`);
			console.log(`App id: ${registry.getAppId()}`);
			console.log(`Owner:  ${self}`);
			console.log(`Tx:     ${txHash}`);
			process.exit(0);
		} catch (err) {
			console.error("Failed:", (err as Error).message);
			process.exit(1);
		}
	});

// ─── register (publisher registration) ─────────────────────────────────────────

program
	.command("register")
	.description("Register your wallet as a data publisher on-chain")
	.action(async () => {
		try {
			const self = getAccount().address;
			const registry = getFangorn().getDataRegistry();
			const s = spinner();

			if (await registry.isRegistered(self)) {
				console.log(`Already registered: ${self}`);
				process.exit(0);
			}

			s.start("Registering publisher...");
			const txHash = await registry.register();
			s.stop();

			console.log(`Publisher: ${self}`);
			console.log(`Tx:        ${txHash}`);
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
	.action(
		async (
			namespaceArg: string | undefined,
			options: {
				owner?: Address;
				fromBlock?: bigint;
				fromStart?: boolean;
				pretty?: boolean;
			},
		) => {
			try {
				const fangorn = getFangorn();

				// Namespace/owner: explicit args win, else fall back to a local repo.
				let namespace = namespaceArg;
				let owner = options.owner;
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
						"namespace required (pass it as an argument or run inside a repo)",
					);
				owner = owner ?? fangorn.getAddress();

				// Resume cursor: last fully-processed block, persisted per (owner, namespace).
				const repoDir = join(process.cwd(), ".fangorn");
				const cursorPath = join(
					repoDir,
					`subscribe-${owner}-${namespace}.json`,
				);
				const readCursor = (): bigint | undefined => {
					if (options.fromStart) return undefined;
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
					`Subscribing to "${namespace}" @ ${owner} ` +
					(fromBlock !== undefined
						? `from block ${fromBlock.toString()}`
						: "(live from current tip)") +
					` — Ctrl-C to stop.`,
				);

				const controller = new AbortController();
				process.on("SIGINT", () => { controller.abort(); });
				process.on("SIGTERM", () => { controller.abort(); });

				for await (const change of fangorn.subscribe({
					namespace,
					owner,
					fromBlock,
					signal: controller.signal,
				})) {
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
