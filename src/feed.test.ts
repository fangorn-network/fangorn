import { describe, expect, it } from "vitest";
import { AppFeed } from "./feed.js";
import type { NamespaceChange } from "./fangorn.js";

const change = (namespace: string) => ({ namespace }) as NamespaceChange;
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A feed whose source is driven by hand, so tests don't wait on a clock. */
function manualFeed() {
	let push!: (c: NamespaceChange) => void;
	let fail!: (err: Error) => void;
	let opened = 0;
	const feed = new AppFeed(async function* (signal) {
		opened += 1;
		// Grouped in an object so TypeScript doesn't narrow these to their
		// values at loop entry — they're set from outside the generator.
		const state = { queue: [] as NamespaceChange[], error: null as Error | null };
		let wake: (() => void) | null = null;
		push = (c) => {
			state.queue.push(c);
			wake?.();
		};
		fail = (e) => {
			state.error = e;
			wake?.();
		};
		const aborted = () => signal.aborted;
		while (!aborted()) {
			if (state.error) throw state.error;
			const next = state.queue.shift();
			if (next) yield next;
			else
				await new Promise<void>((r) => {
					wake = r;
				});
		}
	}, 0);
	return {
		feed,
		push: (ns: string) => {
			push(change(ns));
		},
		fail: (e: Error) => {
			fail(e);
		},
		opened: () => opened,
	};
}

describe("AppFeed", () => {
	it("opens one subscription and fans it out to every listener", async () => {
		const { feed, push, opened } = manualFeed();
		const a: string[] = [];
		const b: string[] = [];
		feed.on((c) => a.push(c.namespace));
		feed.on((c) => b.push(c.namespace));

		push("docs");
		await tick();

		expect(opened()).toBe(1);
		expect(a).toEqual(["docs"]);
		expect(b).toEqual(["docs"]);
	});

	it("stops the subscription when the last listener leaves", async () => {
		const { feed, push } = manualFeed();
		const seen: string[] = [];
		const alsoSeen: string[] = [];
		const off1 = feed.on((c) => {
			seen.push(c.namespace);
		});
		const off2 = feed.on((c) => {
			alsoSeen.push(c.namespace);
		});

		off1();
		expect(feed.size).toBe(1); // still running for off2

		off2();
		expect(feed.size).toBe(0);
		push("docs");
		await tick();
		expect(seen).toEqual([]);
	});

	it("keeps delivering to other listeners when one throws", async () => {
		const { feed, push } = manualFeed();
		const errors: string[] = [];
		const survivor: string[] = [];
		feed.on(
			() => {
				throw new Error("bad consumer");
			},
			(err) => errors.push(err.message),
		);
		feed.on((c) => survivor.push(c.namespace));

		push("docs");
		push("notes");
		await tick();

		expect(errors).toEqual(["bad consumer", "bad consumer"]);
		expect(survivor).toEqual(["docs", "notes"]);
	});

	it("reopens the watch after it fails, without dropping listeners", async () => {
		const { feed, push, fail, opened } = manualFeed();
		const errors: string[] = [];
		const seen: string[] = [];
		feed.on(
			(c) => seen.push(c.namespace),
			(err) => errors.push(err.message),
		);

		fail(new Error("rpc down"));
		await tick();
		await tick();

		expect(errors).toEqual(["rpc down"]);
		expect(opened()).toBe(2);

		push("docs");
		await tick();
		expect(seen).toEqual(["docs"]);
	});
});
