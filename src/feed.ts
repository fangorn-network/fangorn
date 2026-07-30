import type { NamespaceChange } from "./fangorn.js";

/**
 * One shared app-wide commit stream, fanned out to many consumers.
 *
 * `subscribeApp` opens a fresh RPC watch per call. A server that subscribes per
 * connection × per tracked namespace opens N×M pollers for what is the *same*
 * app-level topic filter. This opens exactly one, ref-counted: it starts with
 * the first listener and stops with the last. Consumers filter in memory — the
 * events are already narrowed to the app on-chain.
 */
export class AppFeed {
	private readonly listeners = new Set<{
		onChange: (change: NamespaceChange) => void;
		onError?: (err: Error) => void;
	}>();
	private abort: AbortController | null = null;

	constructor(
		private readonly open: (signal: AbortSignal) => AsyncGenerator<NamespaceChange>,
		/** Delay before reopening the watch after it fails or ends. */
		private readonly restartDelayMs = 2_000,
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
		onChange: (change: NamespaceChange) => void,
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
			}
		};
	}

	private run(): void {
		const abort = new AbortController();
		this.abort = abort;
		// Read through a function so the control-flow analyzer doesn't narrow
		// `aborted` to its value at loop entry — it changes out of band.
		const stopped = () => abort.signal.aborted;
		void (async () => {
			while (!stopped()) {
				try {
					for await (const change of this.open(abort.signal)) {
						// A listener that throws must not take the feed — and every
						// other consumer of it — down with it.
						for (const l of [...this.listeners]) {
							try {
								l.onChange(change);
							} catch (err) {
								report(l, asError(err));
							}
						}
					}
				} catch (err) {
					if (stopped()) return;
					for (const l of [...this.listeners]) report(l, asError(err));
				}
				// The watch ending is not terminal — an RPC hiccup shouldn't leave a
				// long-lived server permanently deaf. ponytail: fixed delay, no
				// backoff; add one if a sustained outage makes this a hot loop.
				if (!stopped())
					await new Promise((r) => setTimeout(r, this.restartDelayMs));
			}
		})();
	}
}

const asError = (err: unknown): Error =>
	err instanceof Error ? err : new Error(String(err));

/**
 * Hand an error to one listener without letting the report itself break the
 * fanout. A listener with no `onError` would otherwise drop the error entirely,
 * and an `onError` that throws would escape the run loop as an unhandled
 * rejection — leaving the feed permanently stopped.
 */
function report(
	listener: { onError?: (err: Error) => void },
	err: Error,
): void {
	if (!listener.onError) {
		console.error("[fangorn] unobserved AppFeed error:", err);
		return;
	}
	try {
		listener.onError(err);
	} catch (reportErr) {
		console.error(
			"[fangorn] AppFeed listener onError threw:",
			asError(reportErr),
			"while reporting:",
			err,
		);
	}
}
