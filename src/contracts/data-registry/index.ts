import {
	keccak256,
	toHex,
	type Abi,
	type AbiEvent,
	type Address,
	type Hash,
	type Hex,
	type PublicClient,
	type TypedDataDomain,
	type WalletClient,
} from "viem";

import { DATA_REGISTRY_ABI } from "./abi.js";
import { getLogsInWindows } from "../logs.js";
import {
	type PreparedTx,
	prepareWrite,
	requireWallet,
	sendWrite,
} from "../write.js";

/** A repo's on-chain id: keccak256 of its name's UTF-8 bytes, never of the name as hex. */
export function repoId(repo: string): Hex {
	return keccak256(toHex(repo));
}

// Data Registry typescript wrapper
//
// The deterministic state machine over the ordering: each repo's head, and the
// update log. Everything the SDK knows about history comes through here; the
// engine only knows the Merkle DAG.
//
// Two implementations:
//   • ChainRegistry — the contracts. Gaps against the paper are listed on the class.
//   • MemRegistry (src/test/mem-registry.ts) — the paper's Apply, in memory: the
//     reference, and the test double.

export const ZERO_HEAD: Hex =
	"0x0000000000000000000000000000000000000000000000000000000000000000";

/** η: epoch length in seconds. e(t) = ⌊t / η⌋. */
export const EPOCH_SECONDS = 3600;

/** W: how many epochs a commit may lag the ordering's clock. */
export const WINDOW = 24;

export function epochOf(unixSeconds: number | bigint): number {
	return Math.floor(Number(unixSeconds) / EPOCH_SECONDS);
}

/** What an update carries: the commit's fields, from which the registry computes its head. */
export interface CommitUpdate {
	repo: string;
	epoch: number;
	/** digest of the parent commit, or ZERO_HEAD */
	parent: Hex;
	/** digest of the event's diff tree */
	diff: Hex;
	/** digest of the state root */
	root: Hex;
	/** the CAR's CID, as bytes */
	car: Hex;
}

export const UPDATE_TYPES = {
	Update: [
		{ name: "publisher", type: "address" },
		{ name: "repo", type: "string" },
		{ name: "epoch", type: "uint64" },
		{ name: "parent", type: "bytes32" },
		{ name: "diff", type: "bytes32" },
		{ name: "root", type: "bytes32" },
		{ name: "car", type: "bytes" },
	],
} as const;

export const dataDomain = (
	chainId: number,
	registry: Address,
): TypedDataDomain => ({
	name: "Fangorn Data",
	version: "1",
	chainId,
	verifyingContract: registry,
});

export const updateMessage = (publisher: Address, u: CommitUpdate) => ({
	publisher,
	repo: u.repo,
	epoch: BigInt(u.epoch),
	parent: u.parent,
	diff: u.diff,
	root: u.root,
	car: u.car,
});

/** ρ = (P, s): one publisher's repo. */
export interface RepoRef {
	publisher: Address;
	repo: string;
}

/** One entry of the update log U, (P, s, i, h, t): a repo's head moved from `parent` to `head`. */
export interface UpdateEntry {
	publisher: Address;
	repo: string;
	/** The head's position in the repo's history, from 1. */
	pos: number;
	parent: Hex;
	head: Hex;
	/** The block the entry is in: where log scans and cursors resume. */
	t: bigint;
	/** That block's timestamp: the `t` of the paper's entry, and what the contract's log leaf hashes. */
	timestamp: bigint;
	/** The entry's position in the whole log (every repo), from 0. Absent on pre-upgrade (V0) logs. */
	index?: bigint;
	/** Unique per entry, for de-duplication across catch-up and live. */
	id: string;
	/** The event's indexed repo id, where the entry came from one (the contract hashes the raw name). */
	repoId?: Hex;
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
	/** H(ρ) with its position (the repo's generation, from 1); (0, ZERO_HEAD) if never written. */
	headAt(ref: RepoRef): Promise<{ pos: number; head: Hex }>;
	/** Moves the signer's repo to the commit `u`. Valid only while `u.parent` is the head (Theorem 3). */
	update(u: CommitUpdate): Promise<Hash>;
	/** `update` as an unsigned transaction for `publisher` to sign. */
	prepareUpdate(publisher: Address, u: CommitUpdate): Promise<PreparedTx>;
	/** The signer's EIP-712 signature over `u`, for `updateBySig`. */
	signUpdate(u: CommitUpdate): Promise<Hex>;
	/** `update` for `publisher`, on its signature. Anyone may submit it. */
	updateBySig(
		publisher: Address,
		u: CommitUpdate,
		signature: Hex,
	): Promise<Hash>;
	/** The update log's mountain range root as of clock `at` (default: now). */
	logRoot(at?: bigint): Promise<Hex>;
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

export interface ChainRegistryConfig {
	dataRegistryContractAddress: Address;
	logWindow?: bigint;
}

/**
 * The registry on the DataRegistry contract.
 *
 * Gap against Definition 3.7: the log is read as events through a trusted RPC,
 * not proven against the contract's mountain range.
 */
export class ChainRegistry implements Registry {
	private readonly data: Address;
	private readonly logWindow?: bigint;

	constructor(
		config: ChainRegistryConfig,
		private publicClient: PublicClient,
		private walletClient?: WalletClient,
	) {
		this.data = config.dataRegistryContractAddress;
		this.logWindow = config.logWindow;
	}

	async epoch(): Promise<number> {
		const block = await this.publicClient.getBlock();
		return epochOf(block.timestamp);
	}

	async head(ref: RepoRef): Promise<Hex> {
		return (await this.headAt(ref)).head;
	}

	async headAt(ref: RepoRef): Promise<{ pos: number; head: Hex }> {
		const [pos, head] = await this.publicClient.readContract({
			address: this.data,
			abi: DATA_REGISTRY_ABI,
			functionName: "getHead",
			args: [ref.publisher, repoId(ref.repo)],
		});
		return { pos: Number(pos), head };
	}

	logRoot(at?: bigint): Promise<Hex> {
		return this.publicClient.readContract({
			address: this.data,
			abi: DATA_REGISTRY_ABI,
			functionName: "logRoot",
			...(at === undefined ? {} : { blockNumber: at }),
		});
	}

	update(u: CommitUpdate): Promise<Hash> {
		return this.write("update", updateArgs(u));
	}

	prepareUpdate(publisher: Address, u: CommitUpdate): Promise<PreparedTx> {
		return prepareWrite(
			this.publicClient,
			publisher,
			this.data,
			DATA_REGISTRY_ABI as unknown as Abi,
			"update",
			updateArgs(u),
			{ fallbackGas: 300_000n },
		);
	}

	async signUpdate(u: CommitUpdate): Promise<Hex> {
		const wallet = requireWallet(this.walletClient, "signUpdate");
		if (!wallet.account)
			throw new Error("signUpdate: the wallet client has no account");
		return wallet.signTypedData({
			account: wallet.account,
			domain: dataDomain(await this.publicClient.getChainId(), this.data),
			types: UPDATE_TYPES,
			primaryType: "Update",
			message: updateMessage(wallet.account.address, u),
		});
	}

	updateBySig(
		publisher: Address,
		u: CommitUpdate,
		signature: Hex,
	): Promise<Hash> {
		return this.write("updateBySig", [publisher, ...updateArgs(u), signature]);
	}

	private write(fn: string, args: readonly unknown[]): Promise<Hash> {
		return sendWrite(
			this.publicClient,
			requireWallet(this.walletClient, fn),
			this.data,
			DATA_REGISTRY_ABI as unknown as Abi,
			fn,
			args,
		);
	}

	/** U's `Updated` events of one version, narrowed on-chain by publisher and repo. */
	private source(filter: LogFilter, event: UpdatedEvent) {
		const ids =
			filter.repo === undefined ? {} : { repo_id: repoId(filter.repo) };
		const who =
			filter.publisher === undefined ? {} : { publisher: filter.publisher };
		return {
			address: this.data,
			abi: [event],
			eventName: "Updated",
			args: { ...who, ...ids },
		};
	}

	async log(
		filter: LogFilter,
		from: bigint,
		to?: bigint,
	): Promise<UpdateEntry[]> {
		// Both versions of the event: the proxy was upgraded in place, so its history
		// before the upgrade carries the old topic.
		const logs = await getLogsInWindows(
			this.publicClient,
			from,
			to,
			async (fromBlock, toBlock) =>
				(
					await Promise.all(
						UPDATED_EVENTS.map((event) =>
							this.publicClient.getContractEvents({
								...this.source(filter, event),
								fromBlock,
								toBlock,
								strict: true,
							} as never),
						),
					)
				).flat(),
			this.logWindow,
		);
		// Windows arrive oldest first, but order within a window is the node's choice.
		const sorted = (logs as unknown as EntryLog[]).sort((a, b) =>
			a.blockNumber === b.blockNumber
				? a.logIndex - b.logIndex
				: a.blockNumber < b.blockNumber
					? -1
					: 1,
		);
		return this.withTimestamps(sorted);
	}

	/**
	 * Old-version logs don't carry their block's timestamp: one block read per
	 * distinct block. New-version logs carry it.
	 */
	private async withTimestamps(logs: EntryLog[]): Promise<UpdateEntry[]> {
		const blocks = [
			...new Set(
				logs
					.filter((l) => l.args.timestamp === undefined)
					.map((l) => l.blockNumber),
			),
		];
		const times = new Map(
			await Promise.all(
				blocks.map(
					async (n) =>
						[
							n,
							(await this.publicClient.getBlock({ blockNumber: n })).timestamp,
						] as const,
				),
			),
		);
		return logs.map((l) =>
			toEntry(l, l.args.timestamp ?? times.get(l.blockNumber) ?? 0n),
		);
	}

	watch(
		filter: LogFilter,
		onEntry: (entry: UpdateEntry) => void,
		onError?: (err: Error) => void,
		pollingInterval?: number,
	): () => void {
		let queue = Promise.resolve();
		const publisher = filter.publisher?.toLowerCase();
		const id = filter.repo === undefined ? undefined : repoId(filter.repo);
		// ONE watch over both event versions, filtered here. Not one watch per version:
		// viem keys a watch by address/eventName/args/interval but not its abi, so two
		// such watches share one poller with the first one's abi, and the other version's
		// logs never arrive (or every log arrives twice).
		// ponytail: no topic filter, so a one-repo watch polls every update on the
		// registry; watch UPDATED alone with `source(filter, UPDATED)` once no deployment
		// still emits UPDATED_V0.
		const unwatch = this.publicClient.watchContractEvent({
			address: this.data,
			abi: UPDATED_EVENTS,
			strict: true,
			pollingInterval,
			// Batches are chained so entries arrive in order even though each waits on block reads.
			onLogs: (logs: (EntryLog & { eventName?: string })[]) => {
				// A reorg re-sends logs it dropped with `removed: true`. They are not
				// updates; the canonical chain's log (if any) arrives on its own.
				const live = logs.filter(
					(l) =>
						!l.removed &&
						l.eventName === "Updated" &&
						(publisher === undefined ||
							l.args.publisher.toLowerCase() === publisher) &&
						(id === undefined || l.args.repo_id === id),
				);
				if (!live.length) return;
				queue = queue
					.then(() => this.withTimestamps(live))
					.then((entries) => {
						for (const e of entries) onEntry(e);
					})
					.catch((e: unknown) => onError?.(e as Error));
			},
			onError,
		} as never);
		return unwatch;
	}

	clock(): Promise<bigint> {
		return this.publicClient.getBlockNumber({ cacheTime: 0 });
	}
}

function updateArgs(u: CommitUpdate) {
	return [u.repo, BigInt(u.epoch), u.parent, u.diff, u.root, u.car] as const;
}

/** `Updated` as the contract emits it. */
const UPDATED = DATA_REGISTRY_ABI.find(
	(i) => i.type === "event" && i.name === "Updated",
) as AbiEvent;

/**
 * `Updated` as the contract emitted it before it gained `index` and `timestamp`
 * (contracts 0f178bb). The proxy is upgraded in place, so the log before the
 * upgrade has this topic.
 */
export const UPDATED_V0 = {
	type: "event",
	name: "Updated",
	anonymous: false,
	inputs: [
		{ name: "publisher", type: "address", indexed: true },
		{ name: "repo_id", type: "bytes32", indexed: true },
		{ name: "repo", type: "string", indexed: false },
		{ name: "pos", type: "uint64", indexed: false },
		{ name: "parent", type: "bytes32", indexed: false },
		{ name: "head", type: "bytes32", indexed: false },
	],
} as const satisfies AbiEvent;

type UpdatedEvent = AbiEvent;
const UPDATED_EVENTS: readonly UpdatedEvent[] = [UPDATED_V0, UPDATED];

/** An `Updated` log, of either version. */
interface EntryLog {
	args: {
		publisher: Address;
		repo_id: Hex;
		repo: string;
		pos: bigint | number;
		parent: Hex;
		head: Hex;
		/** new version only */
		index?: bigint;
		/** new version only: the block's timestamp */
		timestamp?: bigint;
	};
	blockNumber: bigint;
	transactionHash: Hash;
	logIndex: number;
	removed?: boolean;
}

function toEntry(log: EntryLog, timestamp: bigint): UpdateEntry {
	return {
		publisher: log.args.publisher,
		repo: log.args.repo,
		pos: Number(log.args.pos),
		parent: log.args.parent,
		head: log.args.head,
		t: log.blockNumber,
		timestamp,
		index: log.args.index,
		id: `${log.transactionHash}:${log.logIndex.toString()}`,
		repoId: log.args.repo_id,
	};
}
