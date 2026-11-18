import type { RepoChange } from "./fangorn.js";

/**
 * One shared commit stream, fanned out to many consumers.
 *
 * `subscribeAll` opens a fresh RPC watch per call. A server that subscribes per
 * connection × per tracked repo opens N×M pollers for the *same* topic filter.
 * This opens exactly one, ref-counted: it starts with the first listener and
 * stops with the last. Consumers filter in memory.
 *
 * Not a lens (WHITEPAPER_1 §3.4): a lens computes a view over the stream, this
 * only shares the stream. fangorn-md's server fans it out to its connections.
 */
export class CommitFeed {
	private readonly listeners = new Set<{
		onChange: (change: RepoChange) => void;
		onError?: (err: Error) => void;
	}>();
	private abort: AbortController | null = null;
	/**
	 * The last block a change was delivered from, and the changes delivered from it:
	 * a restart resumes there instead of at the tip, and skips what it already sent.
	 */
	private cursor: { block: bigint; sent: Set<string> } | null = null;

	constructor(
		/**
		 * Open the stream: from `fromBlock` when given (a restart), live otherwise.
		 * `onSkip` reports an entry the stream skipped (an unreadable commit) without
		 * ending it; the feed hands it to every listener's `onError`.
		 */
		private readonly open: (
			signal: AbortSignal,
			fromBlock?: bigint,
			onSkip?: (err: Error) => void,
		) => AsyncGenerator<RepoChange>,
		/** Delay before reopening the watch after it fails or ends. */
		private readonly restartDelayMs = 2_000,
		/** Read the current block before opening a replayable chain source. */
		private readonly clock?: () => Promise<bigint>,
	) {}

	/** Number of live listeners — 0 means the underlying watch is closed. */
	get size(): number {
		return this.listeners.size;
	}

	/**
	 * Register a listener, starting the feed if it was idle. Returns the
	 * unsubscribe function; the feed stops once the last listener leaves.
	 */
	on(
		onChange: (change: RepoChange) => void,
		onError?: (err: Error) => void,
	): () => void {
		const listener = { onChange, onError };
		this.listeners.add(listener);
		if (!this.abort) this.run();
		return () => {
			this.listeners.delete(listener);
			if (this.listeners.size === 0) {
				this.abort?.abort();
				this.abort = null;
				// a later start is a new subscription, live from the tip
				this.cursor = null;
			}
		};
	}

	private run(): void {
		const abort = new AbortController();
		this.abort = abort;
		// Read through a function so the control-flow analyzer doesn't narrow
		// `aborted` to its value at loop entry — it changes out of band.
		const stopped = () => abort.signal.aborted;
		const report = (err: Error) => {
			for (const l of [...this.listeners]) l.onError?.(err);
		};
		void (async () => {
			while (!stopped()) {
				try {
					if (!this.cursor && this.clock) {
						const tip = await this.clock();
						if (stopped()) return;
						this.cursor = { block: tip + 1n, sent: new Set() };
					}
					for await (const change of this.open(
						abort.signal,
						this.cursor?.block,
						report,
					)) {
						if (stopped()) return;
						if (!this.advance(change)) continue;
						// A listener that throws must not take the feed — and every
						// other consumer of it — down with it.
						for (const l of [...this.listeners]) {
							try {
								l.onChange(change);
							} catch (err) {
								l.onError?.(asError(err));
							}
						}
					}
				} catch (err) {
					if (stopped()) return;
					report(asError(err));
				}
				// The watch ending is not terminal — an RPC hiccup shouldn't leave a
				// long-lived server permanently deaf. ponytail: fixed delay, no
				// backoff; add one if a sustained outage makes this a hot loop.
				if (!stopped())
					await new Promise((r) => setTimeout(r, this.restartDelayMs));
			}
		})();
	}

	/** Move the cursor past `change`; false if it was already delivered (a restart's replay). */
	private advance(change: RepoChange): boolean {
		// a source that doesn't stamp blocks can't be resumed: pass it through
		if (typeof (change.blockNumber as unknown) !== "bigint") return true;
		const key = `${change.owner}/${change.commitCid}`;
		const c = this.cursor;
		if (c && change.blockNumber < c.block) return false;
		if (c && change.blockNumber === c.block) {
			if (c.sent.has(key)) return false;
			c.sent.add(key);
		} else this.cursor = { block: change.blockNumber, sent: new Set([key]) };
		return true;
	}
}

const asError = (err: unknown): Error =>
	err instanceof Error ? err : new Error(String(err));
