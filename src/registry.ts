import {
	type Abi,
	type Address,
	type Hash,
	type Hex,
	type PublicClient,
	type TypedDataDomain,
	type WalletClient,
} from "viem";

import { DATA_REGISTRY_ABI, type PreparedTx, repoId } from "./contracts/index.js";
import { getLogsInWindows } from "./contracts/logs.js";
import { prepareWrite, requireWallet, sendWrite } from "./contracts/write.js";

// ── The registry (WHITEPAPER_1 §3.2, Definition 3.1) ─────────────────────────
//
// The deterministic state machine over the ordering: each repo's head, and the
// update log. Everything the SDK knows about history comes through here; the
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
		{ name: "root", type: "bytes32" },
		{ name: "car", type: "bytes" },
	],
} as const;

export const dataDomain = (chainId: number, registry: Address): TypedDataDomain => ({
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
	/** Moves the signer's repo to the commit `u`. Valid only while `u.parent` is the head (Theorem 3). */
	update(u: CommitUpdate): Promise<Hash>;
	/** `update` as an unsigned transaction for `publisher` to sign. */
	prepareUpdate(publisher: Address, u: CommitUpdate): Promise<PreparedTx>;
	/** The signer's EIP-712 signature over `u`, for `updateBySig`. */
	signUpdate(u: CommitUpdate): Promise<Hex>;
	/** `update` for `publisher`, on its signature. Anyone may submit it. */
	updateBySig(publisher: Address, u: CommitUpdate, signature: Hex): Promise<Hash>;
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
		const [, head] = await this.publicClient.readContract({
			address: this.data,
			abi: DATA_REGISTRY_ABI,
			functionName: "getHead",
			args: [ref.publisher, repoId(ref.repo)],
		});
		return head;
	}

	update(u: CommitUpdate): Promise<Hash> {
		return this.write(this.data, DATA_REGISTRY_ABI, "update", updateArgs(u));
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
		if (!wallet.account) throw new Error("signUpdate: the wallet client has no account");
		return wallet.signTypedData({
			account: wallet.account,
			domain: dataDomain(await this.publicClient.getChainId(), this.data),
			types: UPDATE_TYPES,
			primaryType: "Update",
			message: updateMessage(wallet.account.address, u),
		});
	}

	updateBySig(publisher: Address, u: CommitUpdate, signature: Hex): Promise<Hash> {
		return this.write(this.data, DATA_REGISTRY_ABI, "updateBySig", [publisher, ...updateArgs(u), signature]);
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

function updateArgs(u: CommitUpdate) {
	return [u.repo, BigInt(u.epoch), u.parent, u.root, u.car] as const;
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
