/* eslint-disable vitest/no-conditional-expect -- the model test's expectations depend on the generated step */
// Drives the real CLI (cli.ts) in-process against a fake Fangorn: the local-state
// machine (stage → commit → push), its exit codes, and what it writes to disk.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";

interface FakeCommit {
	parent: string | null;
	records: { id?: string }[];
	deletes: string[];
}
interface FakeChange {
	blockNumber: bigint;
	n: number;
}

const h = vi.hoisted(() => ({
	tip: null as string | null,
	commits: new Map<string, FakeCommit>(),
	n: 0,
	/** fail the next N calls */
	fail: { commit: 0, push: 0 },
	answers: [] as unknown[],
	changes: [] as FakeChange[],
	/** the subscribe stream throws after yielding this many changes */
	crashAfter: Infinity,
	streamFrom: undefined as bigint | undefined,
	pushCalls: 0,
	failPushOn: 0,
}));

const OWNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

vi.mock("../fangorn.js", () => {
	const mk = (c: FakeCommit) => {
		const cid = `bafy${(++h.n).toString()}`;
		h.commits.set(cid, c);
		return cid;
	};
	const fake = {
		getAddress: () => OWNER,
		initRepo: () => {
			if (h.tip) return Promise.resolve({ alreadyInitialized: true });
			h.tip = mk({ parent: null, records: [], deletes: [] });
			return Promise.resolve({
				alreadyInitialized: false,
				commitCid: h.tip,
				txHash: "0xinit",
			});
		},
		onChainTip: () => Promise.resolve(h.tip),
		commit: (o: {
			records: { id?: string }[];
			deletes: string[];
			parent?: string;
		}) => {
			if (h.fail.commit > 0) {
				h.fail.commit--;
				return Promise.reject(new Error("storage down"));
			}
			const ids = o.records.map((r) => r.id);
			if (new Set(ids).size !== ids.length)
				return Promise.reject(new Error("record id staged twice"));
			const cid = mk({
				parent: o.parent ?? null,
				records: o.records,
				deletes: o.deletes,
			});
			return Promise.resolve({
				commitCid: cid,
				parent: o.parent ?? null,
				root: `root-${cid}`,
			});
		},
		push: (_repo: string, cid: string) => {
			if (++h.pushCalls === h.failPushOn || h.fail.push > 0) {
				if (h.fail.push > 0) h.fail.push--;
				return Promise.reject(new Error("execution reverted"));
			}
			// the registry's compare-and-swap: one commit at a time, on the head
			if (h.commits.get(cid)?.parent !== h.tip)
				return Promise.reject(new Error("stale parent"));
			h.tip = cid;
			return Promise.resolve({ txHash: `0x${cid}`, onChainTip: cid });
		},
		async *log(head: string) {
			await Promise.resolve();
			for (let c: string | null = head; c; ) {
				const parent: string | null = h.commits.get(c)?.parent ?? null;
				yield { cid: c, parent, epoch: 0, root: "" };
				c = parent;
			}
		},
		async *subscribe(o: { fromBlock?: bigint }) {
			await Promise.resolve();
			h.streamFrom = o.fromBlock;
			let i = 0;
			for (const c of h.changes) {
				if (o.fromBlock !== undefined && c.blockNumber < o.fromBlock) continue;
				if (i++ === h.crashAfter) throw new Error("RPC dropped");
				yield c;
			}
		},
	};
	return { Fangorn: { create: () => fake } };
});

vi.mock("@clack/prompts", () => {
	const ask = () => Promise.resolve(h.answers.shift());
	return {
		intro: () => undefined,
		outro: () => undefined,
		spinner: () => ({ start: () => undefined, stop: () => undefined }),
		text: ask,
		password: ask,
		confirm: ask,
		select: ask,
		isCancel: () => false,
	};
});
// index.ts re-exports cli.ts; mocking it keeps each run to the one fresh cli.ts below.
vi.mock("./index.js", () => ({
	handleCancel: () => undefined,
	selectChain: () => Promise.resolve(h.answers.shift()),
}));

const DEBUG = process.env.CLI_DEBUG;
let runs = 0;
interface Run {
	code: number;
	out: string;
}
/** `fangorn ...args` in a fresh copy of cli.ts; resolves on its process.exit. */
async function fangorn(...args: string[]): Promise<Run> {
	let out = "";
	const capture = (...a: unknown[]) => {
		out += a.map(String).join(" ") + "\n";
	};
	const spies = [
		vi.spyOn(console, "log").mockImplementation(capture),
		vi.spyOn(console, "error").mockImplementation(capture),
		vi.spyOn(console, "warn").mockImplementation(capture),
		vi.spyOn(process.stdout, "write").mockImplementation((s, cb?: unknown) => {
			capture(String(s));
			if (typeof cb === "function") (cb as () => void)();
			return true;
		}),
	];
	let done!: (code: number) => void;
	const exited = new Promise<number>((r) => (done = r));
	let first = true;
	spies.push(
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			if (first) done(code ?? 0);
			first = false;
		}) as never),
	);
	isolated();
	process.argv = ["node", "fangorn", ...args];
	try {
		await import(/* @vite-ignore */ `./cli.js?run=${(++runs).toString()}`);
		const code = await exited;
		if (DEBUG)
			process.stderr.write(`[${args.join(" ")}] ${code.toString()}\n${out}\n`);
		return { code, out };
	} finally {
		for (const s of spies) s.mockRestore();
	}
}

const cwd0 = process.cwd();
const env0 = { ...process.env };
let work = "";
let home = "";

function reset() {
	h.tip = null;
	h.commits.clear();
	h.fail = { commit: 0, push: 0 };
	h.answers = [];
	h.changes = [];
	h.crashAfter = Infinity;
	h.streamFrom = undefined;
	h.pushCalls = 0;
	h.failPushOn = 0;
	const base = mkdtempSync(join(tmpdir(), "fangorn-cli-"));
	home = mkdtempSync(join(base, "home-"));
	work = mkdtempSync(join(base, "work-"));
	process.chdir(work);
	// In place: assigning a new object to process.env detaches it from the real
	// environment, and os.homedir() would go on returning the user's real HOME.
	for (const k of Object.keys(process.env))
		if (k !== "PATH") Reflect.deleteProperty(process.env, k);
	process.env.HOME = home;
	// anvil's account #1: a well-known test key
	process.env.ETH_PRIVATE_KEY =
		"0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
	isolated();
}

/** Never let a run touch the user's real ~/.fangorn. */
function isolated() {
	if (homedir() !== home || !home.startsWith(tmpdir()))
		throw new Error(
			`HOME is not isolated (${homedir()}); refusing to run the CLI`,
		);
}

beforeEach(reset);
afterEach(() => {
	process.chdir(cwd0);
	for (const k of Object.keys(process.env))
		Reflect.deleteProperty(process.env, k);
	Object.assign(process.env, env0);
});

const repoJson = () =>
	JSON.parse(readFileSync(join(work, ".fangorn/repo.json"), "utf-8")) as {
		head: string | null;
	};
const indexJson = () =>
	JSON.parse(readFileSync(join(work, ".fangorn/index.json"), "utf-8")) as {
		records: { id?: string }[];
		deletes: string[];
	};

describe("cli local state", () => {
	it("repo init → add → commit → push, exit codes 0, head on chain", async () => {
		expect((await fangorn("repo", "init", "r")).code).toBe(0);
		writeFileSync(join(work, "t.csv"), "id,v\na,1\nb,2\n");
		expect((await fangorn("add", ".")).code).toBe(0);
		expect(indexJson().records.map((r) => r.id)).toEqual(["a", "b"]);
		expect((await fangorn("commit")).code).toBe(0);
		expect(indexJson().records).toEqual([]);
		expect((await fangorn("push")).code).toBe(0);
		expect(h.tip).toBe(repoJson().head);
	});

	it("push settles every unpushed commit, oldest first (two commits, one push)", async () => {
		await fangorn("repo", "init", "r");
		for (const v of ["1", "2"]) {
			writeFileSync(join(work, "t.csv"), `id,v\na,${v}\n`);
			await fangorn("add", "t.csv");
			expect((await fangorn("commit")).code).toBe(0);
		}
		const r = await fangorn("push");
		expect(r.out).not.toMatch(/stale parent/);
		expect(r.code).toBe(0);
		expect(h.tip).toBe(repoJson().head);
	});

	it("a push that fails midway exits 1 and the next push finishes the job", async () => {
		await fangorn("repo", "init", "r");
		for (const v of ["1", "2", "3"]) {
			writeFileSync(join(work, "t.csv"), `id,v\na,${v}\n`);
			await fangorn("add", "t.csv");
			await fangorn("commit");
		}
		const head = repoJson().head;
		const realTip = h.tip;
		h.failPushOn = 2; // the first push lands, the second reverts
		expect((await fangorn("push")).code).toBe(1);
		expect(h.tip).not.toBe(realTip);
		expect(h.tip).not.toBe(head);
		expect((await fangorn("push")).code).toBe(0);
		expect(h.tip).toBe(head);
	});

	it("push refuses, exit 1, when the on-chain tip is not in local history", async () => {
		await fangorn("repo", "init", "r");
		writeFileSync(join(work, "t.txt"), "x");
		await fangorn("add", "t.txt");
		await fangorn("commit");
		// someone pushed from elsewhere
		h.tip = "bafyelsewhere";
		h.commits.set("bafyelsewhere", { parent: null, records: [], deletes: [] });
		const r = await fangorn("push");
		expect(r.code).toBe(1);
		expect(h.tip).toBe("bafyelsewhere");
	});

	it("a failed commit keeps the staging area and head", async () => {
		await fangorn("repo", "init", "r");
		writeFileSync(join(work, "t.txt"), "x");
		await fangorn("add", "t.txt");
		const head = repoJson().head;
		h.fail.commit = 1;
		expect((await fangorn("commit")).code).toBe(1);
		expect(repoJson().head).toBe(head);
		expect(indexJson().records).toHaveLength(1);
	});

	it("a corrupt index.json fails loudly (exit 1), never commits", async () => {
		await fangorn("repo", "init", "r");
		writeFileSync(join(work, ".fangorn/index.json"), '{"records":[{"id"');
		const r = await fangorn("commit");
		expect(r.code).toBe(1);
		expect(h.commits.size).toBe(1);
	});

	it("add refuses (exit 1, nothing staged) when two files give one record id", async () => {
		await fangorn("repo", "init", "r");
		writeFileSync(join(work, "a b.txt"), "one");
		writeFileSync(join(work, "a_b.txt"), "two");
		const r = await fangorn("add", ".");
		expect(r.code).toBe(1);
		expect(r.out).toMatch(/a b\.txt/);
		expect(existsSync(join(work, ".fangorn/index.json"))).toBe(false);
	});

	it("persists source filenames across adds and releases them on rm", async () => {
		await fangorn("repo", "init", "r");
		writeFileSync(join(work, "a b.txt"), "one");
		writeFileSync(join(work, "a_b.txt"), "two");
		expect((await fangorn("add", "a b.txt")).code).toBe(0);
		const index = join(work, ".fangorn/index.json");
		const before = readFileSync(index, "utf8");
		expect((await fangorn("add", "a_b.txt")).code).toBe(1);
		expect(readFileSync(index, "utf8")).toBe(before);
		expect((await fangorn("rm", "a_b.txt")).code).toBe(0);
		expect((await fangorn("add", "a_b.txt")).code).toBe(0);
	});

	it("protects records in an index written before source paths were recorded", async () => {
		await fangorn("repo", "init", "r");
		const index = join(work, ".fangorn/index.json");
		const legacy = JSON.stringify({
			records: [{ id: "a", type: "t", payload: { v: 1 } }],
			deletes: [],
		});
		writeFileSync(index, legacy);
		writeFileSync(join(work, "data.csv"), "id,v\na,2\n");
		expect((await fangorn("add", "data.csv")).out).toContain("unknown source");
		expect(readFileSync(index, "utf8")).toBe(legacy);
		expect((await fangorn("commit")).code).toBe(0);
	});

	it("add names the file that failed to parse", async () => {
		await fangorn("repo", "init", "r");
		writeFileSync(join(work, "bad.json"), "{nope");
		const r = await fangorn("add", ".");
		expect(r.code).toBe(1);
		expect(r.out).toMatch(/bad\.json/);
	});

	it("add takes absolute paths inside the repo", async () => {
		await fangorn("repo", "init", "r");
		writeFileSync(join(work, "t.txt"), "x");
		const r = await fangorn("add", join(work, "t.txt"));
		expect(r.code).toBe(0);
		expect(indexJson().records.map((x) => x.id)).toEqual(["t.txt"]);
	});

	it("add refuses paths outside the repo", async () => {
		await fangorn("repo", "init", "r");
		writeFileSync(join(home, "secret.txt"), "PRIVATE");
		const r = await fangorn("add", join(home, "secret.txt"));
		expect(r.code).toBe(1);
		expect(existsSync(join(work, ".fangorn/index.json"))).toBe(false);
	});
});

describe("cli init (credentials)", () => {
	const KEY =
		"0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
	const config = () => join(home, ".fangorn", "config.json");

	it("writes config.json 0600 in a 0700 dir, and no secret reaches stdout", async () => {
		h.answers = ["baseSepolia", KEY, "jwt-secret", "", ""];
		const r = await fangorn("init");
		expect(r.code).toBe(0);
		expect(statSync(config()).mode & 0o777).toBe(0o600);
		expect(statSync(join(home, ".fangorn")).mode & 0o077).toBe(0);
		expect(r.out).not.toContain(KEY.slice(2));
		expect(r.out).not.toContain("jwt-secret");
		expect(readFileSync(config(), "utf-8")).toContain(KEY);
	});

	it("does not overwrite an existing key unless confirmed", async () => {
		h.answers = ["baseSepolia", KEY, "", "", ""];
		await fangorn("init");
		const before = readFileSync(config(), "utf-8");
		h.answers = [false];
		expect((await fangorn("init")).code).toBe(0);
		expect(readFileSync(config(), "utf-8")).toBe(before);
	});
});

describe("cli subscribe cursor", () => {
	it("a crash mid-block does not skip the rest of that block on resume", async () => {
		await fangorn("repo", "init", "r");
		h.changes = [
			{ blockNumber: 5n, n: 1 },
			{ blockNumber: 7n, n: 2 },
			{ blockNumber: 7n, n: 3 },
			{ blockNumber: 9n, n: 4 },
		];
		h.crashAfter = 2; // yields n=1, n=2 (block 7), then dies
		expect((await fangorn("subscribe", "r", "--owner", OWNER)).code).toBe(1);
		h.crashAfter = Infinity;
		const r = await fangorn("subscribe", "r", "--owner", OWNER);
		expect(r.code).toBe(0);
		expect(r.out).toContain('"n":3');
	});

	it("resumes at the first block after a crash during its delivery", async () => {
		await fangorn("repo", "init", "r");
		h.changes = [
			{ blockNumber: 0n, n: 1 },
			{ blockNumber: 0n, n: 2 },
		];
		h.crashAfter = 1;
		expect((await fangorn("subscribe", "r", "--owner", OWNER)).code).toBe(1);
		h.crashAfter = Infinity;
		const result = await fangorn("subscribe", "r", "--owner", OWNER);
		expect(h.streamFrom).toBe(0n);
		expect(result.out).toContain('"n":2');
	});

	it("keeps the cursor inside .fangorn whatever the namespace", async () => {
		await fangorn("repo", "init", "r");
		h.changes = [
			{ blockNumber: 5n, n: 1 },
			{ blockNumber: 6n, n: 2 },
		];
		// joined onto ".fangorn/subscribe-<owner>-", three ".." land in the working dir
		await fangorn("subscribe", "../../../escaped", "--owner", OWNER);
		expect(existsSync(join(work, "escaped.json"))).toBe(false);
	});
});

// ── stateful model ──────────────────────────────────────────────────────────
//
// Random sequences of add / commit / push with injected storage and chain
// failures. Invariants: exit code says whether the step happened; a failed
// commit leaves the staging area and head; a failed push leaves the chain on an
// ancestor of the local head; and eventually everything committed reaches the chain.

const runsN = Number(process.env.FUZZ_RUNS ?? 8);

describe("cli state machine (fast-check)", () => {
	it("exit codes match outcomes; local/on-chain state stays consistent", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(
					fc.oneof(
						fc.record({ op: fc.constant("add" as const), v: fc.nat(9) }),
						fc.record({
							op: fc.constant("commit" as const),
							fail: fc.boolean(),
						}),
						fc.record({ op: fc.constant("push" as const), fail: fc.boolean() }),
					),
					{ minLength: 1, maxLength: 7 },
				),
				async (ops) => {
					reset();
					expect((await fangorn("repo", "init", "r")).code).toBe(0);
					let staged = 0;
					for (const o of ops) {
						const head = repoJson().head;
						const tip = h.tip;
						if (o.op === "add") {
							writeFileSync(join(work, "t.csv"), `id,v\na,${o.v.toString()}\n`);
							expect((await fangorn("add", "t.csv")).code).toBe(0);
							staged = 1;
						} else if (o.op === "commit") {
							h.fail.commit = o.fail ? 1 : 0;
							const r = await fangorn("commit");
							const ok = staged > 0 && !o.fail;
							expect(r.code).toBe(ok ? 0 : 1);
							if (ok) {
								expect(h.commits.get(repoJson().head ?? "")?.parent).toBe(head);
								staged = 0;
							} else expect(repoJson().head).toBe(head);
							expect(
								existsSync(join(work, ".fangorn/index.json"))
									? indexJson().records.length
									: 0,
							).toBe(staged);
						} else {
							h.fail.push = o.fail ? 1 : 0;
							const r = await fangorn("push");
							const ok = !o.fail || head === tip;
							expect(r.code).toBe(ok ? 0 : 1);
							if (ok) expect(h.tip).toBe(head);
							else expect(h.tip).toBe(tip);
						}
						h.fail = { commit: 0, push: 0 };
					}
					// recovery: one clean push always lands the local head
					expect((await fangorn("push")).code).toBe(0);
					expect(h.tip).toBe(repoJson().head);
				},
			),
			{ numRuns: runsN, seed: 0x5eed1 },
		);
	}, 120_000);
});
