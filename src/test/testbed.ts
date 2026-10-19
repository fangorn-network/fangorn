import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	type Abi,
	type Address,
	createTestClient,
	encodeFunctionData,
	getAddress,
	type Hex,
	http,
	parseEther,
	publicActions,
	walletActions,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Fangorn } from "../fangorn.js";
import { type AppConfig, FangornConfig } from "../config.js";
import { APP_REGISTRY_ABI, DATA_REGISTRY_ABI } from "../contracts/index.js";
import { MemStorage } from "../engine/test-helpers.js";
import { PinataBackend } from "../providers/storage/pinata.js";
import type { MetadataStorage } from "../providers/storage/types.js";
import { MemLedger, MemRegistry } from "./mem-registry.js";

export { MemLedger, MemRegistry } from "./mem-registry.js";

// The networks the suites run on. Both hand out clients the same way, so one
// suite (src/test/sdk-suite.ts) runs on either:
//   • memoryNetwork — the registry in memory (MemRegistry) and storage in memory.
//   • chainNetwork  — the contracts, built from source and deployed to a fresh
//     anvil, with storage in memory, or on Pinata when E2E_STORAGE=pinata.

/** The app every client is accepted into unless told otherwise. */
export const TEST_APP = "test-app";

/** What a suite needs of a network: clients on one ordering and one storage. */
export interface Network {
	name: string;
	storage: MetadataStorage;
	/**
	 * A client for a fresh wallet (or `sk`) under `app`, or under no app for
	 * `null`. On chain it is a joined member of the app: the first client of an
	 * app claims it, and the claimer accepts each later one.
	 */
	client(app?: string | null, sk?: Hex): Promise<Fangorn>;
	/** The ordering's clock (a block number on chain). */
	clock(): Promise<bigint>;
	stop(): void;
}

export function memoryNetwork(Registry: typeof MemRegistry = MemRegistry) {
	const ledger = new MemLedger();
	const storage = new MemStorage();
	return {
		name: "memory",
		ledger,
		storage,
		/** As on chain, a client under an app is one of its members. */
		client(app: string | null = TEST_APP, sk: Hex = generatePrivateKey(), R = Registry): Promise<Fangorn> {
			const f = Fangorn.create({
				privateKey: sk,
				appId: app ?? undefined,
				// The ledger is this deployment, and it starts at 0.
				config: { ...FangornConfig, appRegistryFromBlock: 0n },
				storage: { backend: storage },
				registry: new R(privateKeyToAccount(sk).address, ledger),
			});
			const id = f.getAppId();
			if (id) ledger.members.add(`${id}/${f.getAddress().toLowerCase()}`);
			return Promise.resolve(f);
		},
		clock: () => Promise.resolve(ledger.t),
		stop: () => undefined,
	} satisfies Network & Record<string, unknown>;
}

/** The contracts checkout. Override with FANGORN_CONTRACTS_DIR. */
const CONTRACTS = process.env.FANGORN_CONTRACTS_DIR ?? resolve(import.meta.dirname, "../../../contracts/solidity");

const has = (cmd: string) => spawnSync(cmd, ["--version"]).status === 0;

/**
 * Without anvil, forge or the contracts checkout, a chain suite shows as
 * skipped — except in CI, where it has to fail rather than quietly stop testing.
 */
export const skipChain = !(has("anvil") && has("forge") && existsSync(CONTRACTS)) && !process.env.CI;

/** anvil's first prefunded account: the deployer, and the protocol admin. */
const ADMIN_KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
/** No contract: fees are zero, so the token is never called. */
const NO_TOKEN: Address = "0x000000000000000000000000000000000000dEaD";

async function startAnvil(chainId: number): Promise<{ rpcUrl: string; anvil: ChildProcess }> {
	const anvil = spawn("anvil", ["--port", "0", "--chain-id", String(chainId)], {
		stdio: ["ignore", "pipe", "inherit"],
	});
	const rpcUrl = await new Promise<string>((res, rej) => {
		let out = "";
		anvil.stdout.on("data", (chunk: Buffer) => {
			out += chunk.toString();
			const listening = /Listening on (\S+)/.exec(out);
			if (listening) res(`http://${listening[1]}`);
		});
		anvil.once("error", rej);
		anvil.once("exit", (code) => {
			rej(new Error(`anvil exited (${String(code)}) before it was listening`));
		});
	});
	return { rpcUrl, anvil };
}

function artifact(name: string): { abi: Abi; bytecode: Hex } {
	const json = JSON.parse(readFileSync(`${CONTRACTS}/out/${name}.sol/${name}.json`, "utf-8")) as {
		abi: Abi;
		bytecode: { object: Hex };
	};
	return { abi: json.abi, bytecode: json.bytecode.object };
}

/** Pinata when asked for (E2E_STORAGE=pinata) and configured; memory otherwise. */
function e2eStorage(): MetadataStorage {
	if (process.env.E2E_STORAGE !== "pinata") return new MemStorage();
	const { PINATA_JWT: jwt, PINATA_GATEWAY: gateway } = process.env;
	if (!jwt || !gateway) throw new Error("E2E_STORAGE=pinata needs PINATA_JWT and PINATA_GATEWAY");
	return new PinataBackend(jwt, gateway);
}

/**
 * A fresh anvil with the contracts deployed from source, each behind its
 * ERC-1967 proxy as Deploy.s.sol does, and wired to each other. Fees are zero.
 * Call `stop` from `afterAll`.
 */
export async function chainNetwork() {
	const build = spawnSync("forge", ["build"], { cwd: CONTRACTS, stdio: "inherit" });
	if (build.status !== 0) throw new Error(`forge build failed in ${CONTRACTS}`);

	const { rpcUrl, anvil } = await startAnvil(FangornConfig.chain.id);
	const chain = createTestClient({ mode: "anvil", chain: FangornConfig.chain, transport: http(rpcUrl) })
		.extend(publicActions)
		.extend(walletActions);
	const admin = privateKeyToAccount(ADMIN_KEY);

	const deploy = async (name: string, args: unknown[]): Promise<Address> => {
		const { abi, bytecode } = artifact(name);
		const hash = await chain.deployContract({ account: admin, abi, bytecode, args });
		const { contractAddress } = await chain.waitForTransactionReceipt({ hash });
		if (!contractAddress) throw new Error(`${name} did not deploy`);
		return getAddress(contractAddress);
	};
	const proxied = async (name: string, init: Hex) => deploy("ERC1967Proxy", [await deploy(name, []), init]);

	const apps = await proxied(
		"AppRegistry",
		encodeFunctionData({
			abi: APP_REGISTRY_ABI,
			functionName: "initialize",
			args: [admin.address, NO_TOKEN, 0n, 30n * 24n * 3600n],
		}),
	);
	const data = await proxied(
		"DataRegistry",
		encodeFunctionData({ abi: DATA_REGISTRY_ABI, functionName: "initialize", args: [admin.address, apps] }),
	);
	await chain.waitForTransactionReceipt({
		hash: await chain.writeContract({
			account: admin,
			address: apps,
			abi: APP_REGISTRY_ABI,
			functionName: "setDataRegistry",
			args: [data],
		}),
	});

	const config: AppConfig = {
		...FangornConfig,
		rpcUrl,
		appRegistryContractAddress: apps,
		dataRegistryContractAddress: data,
		appRegistryFromBlock: 0n,
	};
	const storage = e2eStorage();

	/** A wallet with gas: `sk`, or a new one. */
	const wallet = async (sk: Hex = generatePrivateKey()): Promise<Hex> => {
		await chain.setBalance({ address: privateKeyToAccount(sk).address, value: parseEther("1") });
		return sk;
	};
	/** A client and nothing more: no app claimed or accepted into. */
	const raw = async (app?: string, sk?: Hex) =>
		Fangorn.create({ privateKey: await wallet(sk), config, appId: app, storage: { backend: storage } });

	const owners = new Map<string, Fangorn>();
	return {
		name: "chain",
		storage,
		config,
		chain,
		/** The protocol admin's key. */
		adminKey: ADMIN_KEY,
		wallet,
		raw,
		/** The client that claimed `app` through `client`. */
		owner: (app = TEST_APP) => owners.get(app),
		async client(app: string | null = TEST_APP, sk?: Hex): Promise<Fangorn> {
			const f = await raw(app ?? undefined, sk);
			if (app === null) return f;
			const owner = owners.get(app);
			if (!owner) {
				await f.getAppRegistry().registerApp();
				owners.set(app, f);
			} else {
				await owner.getAppRegistry().acceptPublisher(f.getAddress());
			}
			return f;
		},
		clock: () => chain.getBlockNumber({ cacheTime: 0 }),
		stop: () => anvil.kill(),
	} satisfies Network & Record<string, unknown>;
}

export type ChainNetwork = Awaited<ReturnType<typeof chainNetwork>>;
