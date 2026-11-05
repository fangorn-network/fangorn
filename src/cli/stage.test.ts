import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileToRecords, parseCsv, walk } from "./stage.js";

const tmp = (files: Record<string, string | Uint8Array>): string => {
	const dir = mkdtempSync(join(tmpdir(), "stage-"));
	for (const [p, body] of Object.entries(files)) {
		mkdirSync(join(dir, p, ".."), { recursive: true });
		writeFileSync(join(dir, p), body);
	}
	return dir;
};

describe("parseCsv", () => {
	it("handles quotes, escaped quotes, embedded commas/newlines and CRLF", () => {
		expect(parseCsv('a,b\r\n1,"x, ""y""\nz"\r\n2,\n')).toEqual([
			{ a: "1", b: 'x, "y"\nz' },
			{ a: "2", b: "" },
		]);
	});
});

describe("fileToRecords", () => {
	it("csv: a record per row, id from the id column or row number, type from the file name", () => {
		const dir = tmp({ "data/posts.csv": "id,title\np1,Hello\n,Blank\n" });
		expect(fileToRecords(dir, "data/posts.csv", {})).toEqual({
			records: [
				{ id: "p1", type: "posts", payload: { id: "p1", title: "Hello" } },
				{
					id: "data/posts.csv#2",
					type: "posts",
					payload: { id: "", title: "Blank" },
				},
			],
			deletes: [],
		});
	});

	it("text: one record keyed by path; spaces in the path are made id-safe", () => {
		const dir = tmp({ "my notes.txt": "hi" });
		expect(fileToRecords(dir, "my notes.txt", { type: "note" })).toEqual({
			records: [
				{
					id: "my_notes.txt",
					type: "note",
					payload: { path: "my notes.txt", text: "hi" },
				},
			],
			deletes: [],
		});
	});

	it("json: commit-file shape passes through; arrays and jsonl split into records", () => {
		const dir = tmp({
			"c.json":
				'{"records":[{"id":"a","type":"t","payload":{}}],"deletes":["b"]}',
			"arr.json": '[{"id":"x","n":1},{"n":2}]',
			"l.jsonl": '{"n":1}\n\n{"n":2}\n',
		});
		expect(fileToRecords(dir, "c.json", {})).toEqual({
			records: [{ id: "a", type: "t", payload: {} }],
			deletes: ["b"],
		});
		expect(
			fileToRecords(dir, "arr.json", {})?.records.map((r) => r.id),
		).toEqual(["x", "arr.json#2"]);
		expect(fileToRecords(dir, "l.jsonl", {})?.records).toHaveLength(2);
	});

	it("binary: returns null", () => {
		const dir = tmp({ "img.bin": new Uint8Array([1, 0, 2]) });
		expect(fileToRecords(dir, "img.bin", {})).toBeNull();
	});
});

describe("walk", () => {
	it("lists files under a path relative to root, skipping dot entries", () => {
		const dir = tmp({
			"a.txt": "",
			"sub/b.csv": "",
			".fangorn/repo.json": "",
			"sub/.hid": "",
		});
		expect(walk(dir, dir).sort()).toEqual(["a.txt", "sub/b.csv"]);
		expect(walk(dir, join(dir, "sub"))).toEqual(["sub/b.csv"]);
		expect(walk(dir, join(dir, "a.txt"))).toEqual(["a.txt"]);
	});
});
