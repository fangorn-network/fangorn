// Property tests for `fangorn add`'s file → record staging (stage.ts).
// FUZZ_RUNS overrides the run count; seeds are fixed so failures replay.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { addPaths, fileToRecords, walk } from "./stage.js";

const numRuns = Number(process.env.FUZZ_RUNS ?? 100);
const tmp = () => mkdtempSync(join(tmpdir(), "stage-fuzz-"));

// strings rich in CSV metacharacters, plus arbitrary unicode
const cell = fc.oneof(
	fc.string({
		unit: fc.constantFrom('"', ",", "\n", "\r", "\r\n", "a", " ", "é", "🌲"),
	}),
	fc.string({ unit: "grapheme" }),
);

/** RFC 4180: quote a field holding `"`, `,`, CR or LF (and empty ones, so a lone empty field is not a blank line). */
const q = (s: string) =>
	/[",\r\n]/.test(s) || s === "" ? `"${s.replaceAll('"', '""')}"` : s;
const toCsv = (rows: string[][], eol: string) =>
	rows.map((r) => r.map(q).join(",")).join(eol) + eol;

describe("csv staging", () => {
	it("round-trips any table: serialize per RFC 4180, stage, get the rows back", () => {
		fc.assert(
			fc.property(
				fc.uniqueArray(cell, { minLength: 1, maxLength: 5 }),
				fc.array(fc.array(cell, { minLength: 5, maxLength: 5 }), {
					maxLength: 6,
				}),
				fc.constantFrom("\n", "\r\n"),
				fc.boolean(),
				(header, body, eol, bom) => {
					const rows = body.map((r) => r.slice(0, header.length));
					const dir = tmp();
					writeFileSync(
						join(dir, "t.csv"),
						(bom ? "﻿" : "") + toCsv([header, ...rows], eol),
					);
					const got = fileToRecords(dir, "t.csv", { idColumn: "\u0000none" });
					expect(got?.records.map((r) => r.payload)).toEqual(
						rows.map((r) =>
							Object.fromEntries(header.map((h, i) => [h, r[i]])),
						),
					);
					// row ids are path#n: distinct and id-safe
					expect(got?.records.map((r) => r.id)).toEqual(
						rows.map((_, i) => `t.csv#${(i + 1).toString()}`),
					);
				},
			),
			{ numRuns, seed: 0xc5f },
		);
	});

	it("rejects what it cannot read faithfully instead of publishing it mangled", () => {
		const dir = tmp();
		const bad = {
			"q.csv": 'a,b\n"1,2\n',
			"dup.csv": "a,a\n1,2\n",
			"wide.csv": "a\n1,2\n",
		};
		for (const [f, body] of Object.entries(bad)) {
			writeFileSync(join(dir, f), body);
			expect(() => fileToRecords(dir, f, {})).toThrow();
		}
	});
});

describe("json staging", () => {
	it("never pollutes Object.prototype and preserves the payload", () => {
		const key = fc.oneof(
			fc.constantFrom(
				"__proto__",
				"constructor",
				"prototype",
				"id",
				"type",
				"toString",
			),
			fc.string(),
		);
		fc.assert(
			fc.property(
				fc.array(fc.dictionary(key, fc.jsonValue(), { maxKeys: 5 }), {
					maxLength: 4,
				}),
				(rows) => {
					const dir = tmp();
					const text = JSON.stringify(rows);
					writeFileSync(join(dir, "s.json"), text);
					writeFileSync(
						join(dir, "p.json"),
						'{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}}}',
					);
					writeFileSync(join(dir, "p.csv"), "__proto__,constructor\n1,2\n");
					const got = fileToRecords(dir, "s.json", {});
					expect(got?.records.map((r) => r.payload)).toEqual(JSON.parse(text));
					fileToRecords(dir, "p.json", {});
					fileToRecords(dir, "p.csv", {});
					expect(({} as Record<string, unknown>).polluted).toBeUndefined();
					expect(Object.prototype).not.toHaveProperty("polluted");
				},
			),
			{ numRuns, seed: 0x15 },
		);
	});
});

describe("record ids", () => {
	it("distinct files never silently collapse to one id: distinct ids, or add refuses", () => {
		const name = fc.string({
			unit: fc.constantFrom("a", "b", " ", "_", "é", "東", "~", "-"),
			minLength: 1,
			maxLength: 4,
		});
		fc.assert(
			fc.property(
				fc.uniqueArray(name, { minLength: 2, maxLength: 6 }),
				(names) => {
					const dir = tmp();
					for (const n of names) writeFileSync(join(dir, `${n}.txt`), n);
					let staged;
					try {
						staged = addPaths(
							dir,
							[dir],
							{},
							{ records: [], deletes: [] },
						).staged;
					} catch (e) {
						// eslint-disable-next-line vitest/no-conditional-expect -- refusing is one of the two allowed outcomes
						expect((e as Error).message).toMatch(/comes from/);
						return;
					}
					// every file is there, once
					expect(staged.records).toHaveLength(names.length);
					expect(new Set(staged.records.map((r) => r.id)).size).toBe(
						names.length,
					);
				},
			),
			{ numRuns, seed: 0x1d },
		);
	});
});

describe("walk", () => {
	// a generated tree of plain files, dot entries, secrets, and symlinks (out of the repo and back into it)
	const seg = fc.constantFrom(
		"a",
		"b",
		"sub",
		".git",
		".fangorn",
		".env",
		"node",
		"x.csv",
	);
	it("never yields dot paths, never leaves the repo, never loops", () => {
		fc.assert(
			fc.property(
				fc.array(fc.array(seg, { minLength: 1, maxLength: 4 }), {
					minLength: 1,
					maxLength: 12,
				}),
				fc.array(
					fc.tuple(
						fc.array(seg, { minLength: 1, maxLength: 3 }),
						fc.constantFrom("root", "outside", "self"),
					),
					{ maxLength: 4 },
				),
				(files, links) => {
					const base = tmp();
					const root = join(base, "repo");
					const outside = join(base, "outside");
					mkdirSync(root);
					mkdirSync(outside);
					writeFileSync(join(outside, "SECRET"), "k");
					for (const f of files) {
						try {
							mkdirSync(join(root, ...f.slice(0, -1)), { recursive: true });
							writeFileSync(join(root, ...f), "1");
						} catch {
							/* a path used as both file and dir: skip */
						}
					}
					for (const [at, to] of links) {
						const p = join(root, ...at);
						try {
							mkdirSync(dirname(p), { recursive: true });
							symlinkSync(
								to === "outside" ? outside : to === "root" ? root : dirname(p),
								p,
							);
						} catch {
							/* taken */
						}
					}
					const got = walk(root, root);
					for (const p of got) {
						expect(p.split("/").some((s) => s.startsWith("."))).toBe(false);
						expect(p).not.toMatch(/SECRET/);
					}
					expect(new Set(got).size).toBe(got.length);
					expect(got).toEqual([...got].sort());
				},
			),
			{ numRuns: Math.min(numRuns, 50), seed: 0x3a1c },
		);
	});

	it("refuses paths outside the repo", () => {
		const base = tmp();
		mkdirSync(join(base, "repo"));
		writeFileSync(join(base, "secret"), "k");
		expect(() => walk(join(base, "repo"), join(base, "secret"))).toThrow(
			/outside the repo/,
		);
		expect(() => walk(join(base, "repo"), base)).toThrow(/outside the repo/);
	});
});
