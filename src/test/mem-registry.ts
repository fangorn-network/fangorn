import { verifyTypedData, type Address, type Hash, type Hex, type LocalAccount } from "viem";
import { type PreparedTx } from "../contracts/index.js";
import { commitHead } from "../engine/index.js";
import {
	type CommitUpdate,
	type LogFilter,
	type Registry,
	type RepoRef,
	type UpdateEntry,
	UPDATE_TYPES,
	WINDOW,
	ZERO_HEAD,
	dataDomain,
	epochOf,
	updateMessage,
} from "../registry.js";

/** The EIP-712 domain a MemRegistry signs under. */
export const MEM_DOMAIN = dataDomain(31337, "0x000000000000000000000000000000000000da7a");

// The registry as WHITEPAPER_1 Definition 3.1 defines it, in memory: the
// reference the chain is checked against, and the test double. Nothing outside
// tests uses it.

const refKey = (r: RepoRef) => `${r.publisher.toLowerCase()}/${r.repo}`;

/** One ordering and the registry state over it, shared by every signer of a MemRegistry. */
export class MemLedger {
	/** H: position and head */
	heads = new Map<string, { pos: number; head: Hex }>();
	/** U */
	entries: UpdateEntry[] = [];
	/** The clock: one tick per entry of the ordering. */
	t = 0n;
	listeners = new Set<(entry: UpdateEntry) => void>();

	append(entry: Omit<UpdateEntry, "t" | "id">) {
		this.t++;
		const e = { ...entry, t: this.t, id: this.entries.length.toString() };
		this.entries.push(e);
		for (const listener of this.listeners) listener(e);
	}
}

const matches = (filter: LogFilter, e: UpdateEntry) =>
	(!filter.publisher || e.publisher.toLowerCase() === filter.publisher.toLowerCase()) &&
	(!filter.repo || e.repo === filter.repo);

/**
 * The paper's Apply, signing as `signer`. Signers that share a ledger see each
 * other's writes, like wallets on one chain.
 */
export class MemRegistry implements Registry {
	constructor(
		public signer: Address,
		public ledger = new MemLedger(),
		public now = () => Math.floor(Date.now() / 1000),
		public account?: LocalAccount,
	) {}

	epoch(): Promise<number> {
		return Promise.resolve(epochOf(this.now()));
	}

	head(ref: RepoRef): Promise<Hex> {
		return Promise.resolve(this.ledger.heads.get(refKey(ref))?.head ?? ZERO_HEAD);
	}

	update(u: CommitUpdate): Promise<Hash> {
		return this.apply(this.signer, u);
	}

	signUpdate(u: CommitUpdate): Promise<Hex> {
		if (!this.account) return Promise.reject(new Error("MemRegistry has no account to sign with"));
		return this.account.signTypedData({
			domain: MEM_DOMAIN,
			types: UPDATE_TYPES,
			primaryType: "Update",
			message: updateMessage(this.account.address, u),
		});
	}

	async updateBySig(publisher: Address, u: CommitUpdate, signature: Hex): Promise<Hash> {
		const ok = await verifyTypedData({
			address: publisher,
			domain: MEM_DOMAIN,
			types: UPDATE_TYPES,
			primaryType: "Update",
			message: updateMessage(publisher, u),
			signature,
		});
		if (!ok) throw new Error("BadSignature");
		return this.apply(publisher, u);
	}

	private async apply(publisher: Address, u: CommitUpdate): Promise<Hash> {
		const now = epochOf(this.now());
		if (u.epoch > now || u.epoch + WINDOW < now) throw new Error("EpochOutOfWindow");
		const ref = { publisher, repo: u.repo };
		if ((await this.head(ref)) !== u.parent) throw new Error("StaleStateRoot");
		const head = await commitHead(u);
		const pos = (this.ledger.heads.get(refKey(ref))?.pos ?? 0) + 1;
		this.ledger.heads.set(refKey(ref), { pos, head });
		this.ledger.append({ publisher, repo: u.repo, pos, parent: u.parent, head });
		return "0x00";
	}

	prepareUpdate(): Promise<PreparedTx> {
		return Promise.reject(new Error("MemRegistry has no transactions to prepare"));
	}

	log(filter: LogFilter, from: bigint, to?: bigint): Promise<UpdateEntry[]> {
		return Promise.resolve(
			this.ledger.entries.filter((e) => e.t >= from && (to === undefined || e.t <= to) && matches(filter, e)),
		);
	}

	watch(filter: LogFilter, onEntry: (entry: UpdateEntry) => void): () => void {
		const listener = (e: UpdateEntry) => {
			if (matches(filter, e)) onEntry(e);
		};
		this.ledger.listeners.add(listener);
		return () => this.ledger.listeners.delete(listener);
	}

	clock(): Promise<bigint> {
		return Promise.resolve(this.ledger.t);
	}
}
