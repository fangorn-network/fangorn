import {
	encodeAbiParameters,
	type Abi,
	type Address,
	type Hash,
	type Hex,
	keccak256,
	type PublicClient,
	type WalletClient,
} from "viem";

import { APP_REGISTRY_ABI, DATA_REGISTRY_ABI, type PreparedTx, repoId } from "./contracts/index.js";
import { getLogsInWindows } from "./contracts/logs.js";
import { prepareWrite, requireWallet, sendWrite } from "./contracts/write.js";

// ── The registry (WHITEPAPER_1 §3.2, Definition 3.1) ─────────────────────────
//
// The deterministic state machine over the ordering that says what every entry
// means: each repo's head, which publishers each app presents, and what each app
// has excluded. Everything the SDK knows about history comes through here; the
// engine only knows the Merkle DAG.
//
// Two implementations:
//   • ChainRegistry — the contracts. Gaps against the paper are listed on the class.
//   • MemRegistry (src/test/testbed.ts) — the paper's Apply, in memory: the
//     reference, and the test double.

export const ZERO_HEAD: Hex =
	"0x0000000000000000000000000000000000000000000000000000000000000000";

/** η: epoch length in seconds. e(t) = ⌊t / η⌋. */
export const EPOCH_SECONDS = 3600;

export function epochOf(unixSeconds: number | bigint): number {
	return Math.floor(Number(unixSeconds) / EPOCH_SECONDS);
}

/** ρ = (P, s): one publisher's repo. */
export interface RepoRef {
	publisher: Address;
	repo: string;
}

/** What an exclusion names in an app: a whole publisher, one of its repos, or one record key in a repo. */
export interface Exclusion {
	publisher: Address;
	repo?: string;
	key?: string;
}

/** One entry of the update log U, (P, s, i, h, t): a repo's head moved from `parent` to `head`. */
export interface UpdateEntry {
	publisher: Address;
	repo: string;
	/** The head's position in the repo's history, from 1. */
	pos: number;
	parent: Hex;
	head: Hex;
	/** The ordering's clock at the entry (a block number). */
	t: bigint;
	/** Unique per entry, for de-duplication across catch-up and live. */
	id: string;
}

/** A slice of the update log: every repo, one publisher's, one repo name across publishers, or one repo. */
export interface LogFilter {
	publisher?: Address;
	repo?: string;
}

export interface Registry {
	/** e(t) at the ordering's current clock. A commit's epoch must be within W of it. */
	epoch(): Promise<number>;
	/** H(ρ): the committed head, or ZERO_HEAD for a repo never written. */
	head(ref: RepoRef): Promise<Hex>;
	/**
	 * Does app A present `publisher`? Exactly while it provides the publisher's
	 * storage (`canPublish`): an app presents its publishers' latest heads, less
	 * its exclusions. ponytail: the paper's per-head acceptance (α_A), once apps
	 * validate what they present.
	 */
	presents(app: Hex, publisher: Address): Promise<boolean>;
	/** C(A, X). Odd means X is in force (Proposition 3.2). */
	exclusionCount(app: Hex, x: Exclusion): Promise<number>;
	/** update(s, parent → head), as the signer. Valid only while `parent` is the head (Theorem 3). It names no app. */
	update(repo: string, parent: Hex, head: Hex): Promise<Hash>;
	/** `update` as an unsigned transaction for `publisher` to sign. */
	prepareUpdate(publisher: Address, repo: string, parent: Hex, head: Hex): Promise<PreparedTx>;
	exclude(app: Hex, x: Exclusion): Promise<Hash>;
	restore(app: Hex, x: Exclusion): Promise<Hash>;
	/** The entries of a log between two clock values, oldest first. */
	log(filter: LogFilter, from: bigint, to?: bigint): Promise<UpdateEntry[]>;
	/** Follow the log live. Returns an unsubscribe function. */
	watch(
		filter: LogFilter,
		onEntry: (entry: UpdateEntry) => void,
		onError?: (err: Error) => void,
		pollingInterval?: number,
	): () => void;
	/** The ordering's current clock value (a block number). */
	clock(): Promise<bigint>;
}

/** True if exclusion `x` covers record `key` of repo `ref`. */
export function covers(x: Exclusion, ref: RepoRef, key?: string): boolean {
	if (x.publisher.toLowerCase() !== ref.publisher.toLowerCase()) return false;
	if (x.repo === undefined) return true;
	if (x.repo !== ref.repo) return false;
	return x.key === undefined || x.key === key;
}

/**
 * Is anything of `ref` hidden in app `app`? Checks the publisher and the repo
 * exclusions, the two that can hide a whole repo (ReadSlice line 3).
 */
export async function repoExcluded(registry: Registry, app: Hex, ref: RepoRef): Promise<boolean> {
	const counts = await Promise.all([
		registry.exclusionCount(app, { publisher: ref.publisher }),
		registry.exclusionCount(app, ref),
	]);
	return counts.some((c) => c % 2 === 1);
}

const ZERO: Hex = ZERO_HEAD;

/** The slot an exclusion is counted in: keccak256(abi.encode(P, N(s), N(k))), zeros for levels it doesn't name. */
export function exclusionId(x: Exclusion): Hex {
	return keccak256(
		encodeAbiParameters(
			[{ type: "address" }, { type: "bytes32" }, { type: "bytes32" }],
			[x.publisher, x.repo === undefined ? ZERO : repoId(x.repo), x.key === undefined ? ZERO : repoId(x.key)],
		),
	);
}

export interface ChainRegistryConfig {
	dataRegistryContractAddress: Address;
	appRegistryContractAddress: Address;
	// TODO: membership registry?
	logWindow?: bigint;
}

/**
 * The registry on the contracts: H and U in the DataRegistry; membership, X and C
 * in the AppRegistry.
 *
 * Gaps against Definition 3.1, each closed by the contract spec
 * (docs/REGISTRY_SPEC.md):
 *   • the contract doesn't check the commit's epoch, nor compute the head from
 *     (e, parent, root). The client checks the parent before it sends an update;
 *   • no per-head acceptance: an app presents the latest heads of the publishers
 *     whose storage it provides (`canPublish`). χ_A is the owner's say. No rule
 *     contracts, no witnesses;
 *   • the protocol admin's network-wide ban, which the paper doesn't have, reads
 *     as a publisher exclusion in every app;
 *   • the logs are events read through a trusted RPC: no MMR, no proofs.
 */
export class ChainRegistry implements Registry {
	private readonly data: Address;
	private readonly apps: Address;
	private readonly logWindow?: bigint;

	constructor(
		config: ChainRegistryConfig,
		private publicClient: PublicClient,
		private walletClient?: WalletClient,
	) {
		this.data = config.dataRegistryContractAddress;
		this.apps = config.appRegistryContractAddress;
		this.logWindow = config.logWindow;
	}

	async epoch(): Promise<number> {
		const block = await this.publicClient.getBlock();
		return epochOf(block.timestamp);
	}

	async head(ref: RepoRef): Promise<Hex> {
		const [, head] = await this.publicClient.readContract({
			address: this.data,
			abi: DATA_REGISTRY_ABI,
			functionName: "getHead",
			args: [ref.publisher, repoId(ref.repo)],
		});
		return head;
	}

	presents(app: Hex, publisher: Address): Promise<boolean> {
		return this.publicClient.readContract({
			address: this.apps,
			abi: APP_REGISTRY_ABI,
			functionName: "canPublish",
			args: [app, publisher],
		});
	}

	async exclusionCount(app: Hex, x: Exclusion): Promise<number> {
		const [count, banned] = await Promise.all([
			this.publicClient.readContract({
				address: this.apps,
				abi: APP_REGISTRY_ABI,
				functionName: "exclusionCount",
				args: [app, exclusionId(x)],
			}),
			x.repo === undefined
				? this.publicClient.readContract({
						address: this.apps,
						abi: APP_REGISTRY_ABI,
						functionName: "globalSuspensions",
						args: [x.publisher],
					})
				: false,
		]);
		return banned ? Number(count) | 1 : Number(count);
	}

	update(repo: string, parent: Hex, head: Hex): Promise<Hash> {
		return this.write(this.data, DATA_REGISTRY_ABI, "update", [repo, parent, head]);
	}

	prepareUpdate(publisher: Address, repo: string, parent: Hex, head: Hex): Promise<PreparedTx> {
		return prepareWrite(
			this.publicClient,
			publisher,
			this.data,
			DATA_REGISTRY_ABI as unknown as Abi,
			"update",
			[repo, parent, head],
			{ fallbackGas: 200_000n },
		);
	}

	exclude(app: Hex, x: Exclusion): Promise<Hash> {
		return this.write(this.apps, APP_REGISTRY_ABI, "exclude", exclusionArgs(app, x));
	}

	restore(app: Hex, x: Exclusion): Promise<Hash> {
		return this.write(this.apps, APP_REGISTRY_ABI, "restore", exclusionArgs(app, x));
	}

	private write(address: Address, abi: Abi | readonly unknown[], fn: string, args: readonly unknown[]): Promise<Hash> {
		return sendWrite(this.publicClient, requireWallet(this.walletClient, fn), address, abi as Abi, fn, args);
	}

	/** U's `Updated` events, narrowed on-chain by publisher and repo. */
	private source(filter: LogFilter) {
		const ids = filter.repo === undefined ? {} : { repo_id: repoId(filter.repo) };
		const who = filter.publisher === undefined ? {} : { publisher: filter.publisher };
		return { address: this.data, abi: DATA_REGISTRY_ABI, eventName: "Updated", args: { ...who, ...ids } };
	}

	async log(filter: LogFilter, from: bigint, to?: bigint): Promise<UpdateEntry[]> {
		const logs = await getLogsInWindows(this.publicClient, from, to, (fromBlock, toBlock) =>
			this.publicClient.getContractEvents({ ...this.source(filter), fromBlock, toBlock, strict: true } as never),
			this.logWindow,
		);
		// Windows arrive oldest first, but order within a window is the node's choice.
		return (logs as unknown as EntryLog[])
			.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1))
			.map(toEntry);
	}

	watch(
		filter: LogFilter,
		onEntry: (entry: UpdateEntry) => void,
		onError?: (err: Error) => void,
		pollingInterval?: number,
	): () => void {
		return this.publicClient.watchContractEvent({
			...this.source(filter),
			strict: true,
			pollingInterval,
			onLogs: (logs: EntryLog[]) => {
				for (const log of logs) onEntry(toEntry(log));
			},
			onError,
		} as never);
	}

	clock(): Promise<bigint> {
		return this.publicClient.getBlockNumber({ cacheTime: 0 });
	}
}

function exclusionArgs(app: Hex, x: Exclusion): readonly unknown[] {
	return [app, x.publisher, x.repo === undefined ? ZERO : repoId(x.repo), x.key === undefined ? ZERO : repoId(x.key)];
}

/** An `Updated` log. */
interface EntryLog {
	args: { publisher: Address; repo: string; pos: bigint | number; parent: Hex; head: Hex };
	blockNumber: bigint;
	transactionHash: Hash;
	logIndex: number;
}

function toEntry(log: EntryLog): UpdateEntry {
	return {
		publisher: log.args.publisher,
		repo: log.args.repo,
		pos: Number(log.args.pos),
		parent: log.args.parent,
		head: log.args.head,
		t: log.blockNumber,
		id: `${log.transactionHash}:${log.logIndex.toString()}`,
	};
}
