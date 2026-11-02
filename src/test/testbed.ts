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
import { foundry } from "viem/chains";
import { Fangorn } from "../fangorn.js";
import { type AppConfig, FangornConfig } from "../config.js";
import { APP_REGISTRY_ABI, DATA_REGISTRY_ABI, SETTLEMENT_REGISTRY_ABI } from "../contracts/index.js";
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

/** What a suite needs of a network: clients on one ordering and one storage. */
export interface Network {
	name: string;
	storage: MetadataStorage;
	/** A client for a fresh wallet, or for `sk`. */
	client(sk?: Hex): Promise<Fangorn>;
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
		client(sk: Hex = generatePrivateKey(), R = Registry): Promise<Fangorn> {
			return Promise.resolve(Fangorn.create({
				privateKey: sk,
				// The ledger is this deployment, and it starts at 0.
				config: { ...FangornConfig, appRegistryFromBlock: 0n },
				storage: { backend: storage },
				registry: new R(privateKeyToAccount(sk).address, ledger),
			}));
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

/** `file`: the .sol it is in, when that isn't `name`.sol. */
function artifact(name: string, file = name): { abi: Abi; bytecode: Hex } {
	const json = JSON.parse(readFileSync(`${CONTRACTS}/out/${file}.sol/${name}.json`, "utf-8")) as {
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
 * ERC-1967 proxy as Deploy.s.sol does, and wired to each other.
 * Call `stop` from `afterAll`.
 */
export async function chainNetwork() {
	const build = spawnSync("forge", ["build"], { cwd: CONTRACTS, stdio: "inherit" });
	if (build.status !== 0) throw new Error(`forge build failed in ${CONTRACTS}`);

	const { rpcUrl, anvil } = await startAnvil(FangornConfig.chain.id);
	// The default network's id on a plain chain: Base's OP Stack formatters make this
	// function's inferred type too large for the .d.ts build (TS7056), and anvil
	// needs only the id.
	const chain = createTestClient({ mode: "anvil", chain: { ...foundry, id: FangornConfig.chain.id }, transport: http(rpcUrl) })
		.extend(publicActions)
		.extend(walletActions);
	const admin = privateKeyToAccount(ADMIN_KEY);

	const deploy = async (name: string, args: unknown[], file?: string): Promise<Address> => {
		const { abi, bytecode } = artifact(name, file);
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
			args: [admin.address],
		}),
	);
	const data = await proxied(
		"DataRegistry",
		encodeFunctionData({ abi: DATA_REGISTRY_ABI, functionName: "initialize", args: [admin.address] }),
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

	// Payments and proofs are mocked (contracts repo, test/Mocks.sol): USDC
	// doesn't check signatures and Semaphore accepts any proof.
	const usdc = await deploy("MockUSDC", [], "Mocks");
	const settlement = await proxied(
		"SettlementRegistry",
		encodeFunctionData({
			abi: SETTLEMENT_REGISTRY_ABI,
			functionName: "initialize",
			args: [admin.address, usdc, await deploy("MockSemaphore", [], "Mocks")],
		}),
	);

	const config: AppConfig = {
		...FangornConfig,
		rpcUrl,
		appRegistryContractAddress: apps,
		dataRegistryContractAddress: data,
		settlementRegistryContractAddress: settlement,
		appRegistryFromBlock: 0n,
	};
	const storage = e2eStorage();

	/** A wallet with gas: `sk`, or a new one. */
	const wallet = async (sk: Hex = generatePrivateKey()): Promise<Hex> => {
		await chain.setBalance({ address: privateKeyToAccount(sk).address, value: parseEther("1") });
		return sk;
	};
	/** A client with gas, managing `app` if given. */
	const raw = async (app?: string, sk?: Hex) =>
		Fangorn.create({ privateKey: await wallet(sk), config, appId: app, storage: { backend: storage } });

	return {
		name: "chain",
		storage,
		config,
		chain,
		/** MockUSDC: `balanceOf` is what each address has been paid. */
		usdc,
		/** The protocol admin's key. */
		adminKey: ADMIN_KEY,
		wallet,
		raw,
		client: (sk?: Hex) => raw(undefined, sk),
		clock: () => chain.getBlockNumber({ cacheTime: 0 }),
		stop: () => anvil.kill(),
	} satisfies Network & Record<string, unknown>;
}

export type ChainNetwork = Awaited<ReturnType<typeof chainNetwork>>;
