import type { Address, Hash, Hex } from "viem";
import { type PreparedTx } from "../contracts/index.js";
import {
	type Exclusion,
	type LogFilter,
	type Registry,
	type RepoRef,
	type UpdateEntry,
	ZERO_HEAD,
	epochOf,
} from "../registry.js";

// The registry as WHITEPAPER_1 Definition 3.1 defines it, in memory: the
// reference the chain is checked against, and the test double. Nothing outside
// tests uses it.

const refKey = (r: RepoRef) => `${r.publisher.toLowerCase()}/${r.repo}`;
const exclKey = (x: Exclusion) => `${x.publisher.toLowerCase()}/${x.repo ?? ""}/${x.key ?? ""}`;

/** One ordering and the registry state over it, shared by every signer of a MemRegistry. */
export class MemLedger {
	/** H: position and head */
	heads = new Map<string, { pos: number; head: Hex }>();
	/** `app/publisher` for each publisher an app presents (provides storage to) */
	members = new Set<string>();
	/** C, per app */
	counts = new Map<string, number>();
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
 * The paper's Apply, signing as `signer`. Membership is whatever the ledger is
 * told (`members`): its rules (invites, terms, suspensions) are the contracts'
 * business. Signers that share a ledger see each other's writes, like wallets on
 * one chain.
 */
export class MemRegistry implements Registry {
	constructor(
		public signer: Address,
		public ledger = new MemLedger(),
		public now = () => Math.floor(Date.now() / 1000),
	) {}

	epoch(): Promise<number> {
		return Promise.resolve(epochOf(this.now()));
	}

	head(ref: RepoRef): Promise<Hex> {
		return Promise.resolve(this.ledger.heads.get(refKey(ref))?.head ?? ZERO_HEAD);
	}

	presents(app: Hex, publisher: Address): Promise<boolean> {
		return Promise.resolve(this.ledger.members.has(`${app}/${publisher.toLowerCase()}`));
	}

	exclusionCount(app: Hex, x: Exclusion): Promise<number> {
		return Promise.resolve(this.ledger.counts.get(`${app}/${exclKey(x)}`) ?? 0);
	}

	async update(repo: string, parent: Hex, head: Hex): Promise<Hash> {
		const ref = { publisher: this.signer, repo };
		if ((await this.head(ref)) !== parent) throw new Error("StaleStateRoot");
		const pos = (this.ledger.heads.get(refKey(ref))?.pos ?? 0) + 1;
		this.ledger.heads.set(refKey(ref), { pos, head });
		this.ledger.append({ publisher: this.signer, repo, pos, parent, head });
		return "0x00";
	}

	prepareUpdate(): Promise<PreparedTx> {
		return Promise.reject(new Error("MemRegistry has no transactions to prepare"));
	}

	exclude(app: Hex, x: Exclusion): Promise<Hash> {
		return this.flip(app, x, 0);
	}

	restore(app: Hex, x: Exclusion): Promise<Hash> {
		return this.flip(app, x, 1);
	}

	/** exclude needs an even count, restore an odd one; both add one. */
	private async flip(app: Hex, x: Exclusion, parity: number): Promise<Hash> {
		const n = await this.exclusionCount(app, x);
		if (n % 2 !== parity) throw new Error(parity ? "NotExcluded" : "AlreadyExcluded");
		this.ledger.counts.set(`${app}/${exclKey(x)}`, n + 1);
		return "0x00";
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
