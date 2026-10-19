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

type Entry = UpdateEntry & { app?: Hex };

/** One ordering and the registry state over it, shared by every signer of a MemRegistry. */
export class MemLedger {
	/** H: position and head */
	heads = new Map<string, { pos: number; head: Hex }>();
	/** D, per app */
	acceptedHeads = new Map<string, { pos: number; head: Hex }>();
	/** C, per app */
	counts = new Map<string, number>();
	/** U, and every app log, each entry tagged with its app */
	entries: Entry[] = [];
	/** The clock: one tick per entry of the ordering. Carried acceptances share their update's. */
	t = 0n;
	listeners = new Set<(entry: Entry) => void>();

	append(entry: Omit<Entry, "t" | "id">, tick: boolean) {
		if (tick) this.t++;
		const e = { ...entry, t: this.t, id: this.entries.length.toString() };
		this.entries.push(e);
		for (const listener of this.listeners) listener(e);
	}
}

const matches = (filter: LogFilter, e: Entry) =>
	e.app === filter.app &&
	(!filter.publisher || e.publisher.toLowerCase() === filter.publisher.toLowerCase()) &&
	(!filter.repo || e.repo === filter.repo);

/**
 * The paper's Apply, signing as `signer`. Every acceptance is valid: membership
 * (α_A) is the contracts' business. Signers that share a ledger see each other's
 * writes, like wallets on one chain.
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

	accepted(app: Hex, ref: RepoRef): Promise<Hex> {
		return Promise.resolve(this.ledger.acceptedHeads.get(`${app}/${refKey(ref)}`)?.head ?? ZERO_HEAD);
	}

	exclusionCount(app: Hex, x: Exclusion): Promise<number> {
		return Promise.resolve(this.ledger.counts.get(`${app}/${exclKey(x)}`) ?? 0);
	}

	async update(repo: string, parent: Hex, head: Hex, apps: Hex[] = []): Promise<Hash> {
		const ref = { publisher: this.signer, repo };
		if ((await this.head(ref)) !== parent) throw new Error("StaleStateRoot");
		const pos = (this.ledger.heads.get(refKey(ref))?.pos ?? 0) + 1;
		this.ledger.heads.set(refKey(ref), { pos, head });
		this.ledger.append({ publisher: this.signer, repo, pos, parent, head }, true);
		for (const app of apps) await this.applyAccept(app, ref, false).catch(() => undefined);
		return "0x00";
	}

	prepareUpdate(): Promise<PreparedTx> {
		return Promise.reject(new Error("MemRegistry has no transactions to prepare"));
	}

	accept(app: Hex, ref: RepoRef): Promise<Hash> {
		return this.applyAccept(app, ref, true);
	}

	private applyAccept(app: Hex, ref: RepoRef, tick: boolean): Promise<Hash> {
		const current = this.ledger.heads.get(refKey(ref));
		const key = `${app}/${refKey(ref)}`;
		const before = this.ledger.acceptedHeads.get(key);
		if (!current || current.pos <= (before?.pos ?? 0)) return Promise.reject(new Error("StaleAcceptance"));
		this.ledger.acceptedHeads.set(key, current);
		this.ledger.append({ app, publisher: ref.publisher, repo: ref.repo, pos: current.pos, parent: before?.head ?? ZERO_HEAD, head: current.head }, tick);
		return Promise.resolve("0x00");
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
		const listener = (e: Entry) => {
			if (matches(filter, e)) onEntry(e);
		};
		this.ledger.listeners.add(listener);
		return () => this.ledger.listeners.delete(listener);
	}

	clock(): Promise<bigint> {
		return Promise.resolve(this.ledger.t);
	}
}
