import { readFileSync, readdirSync, statSync } from "fs";
import { basename, extname, join, relative, sep } from "path";
import type { RecordInput } from "../engine/index.js";

// Turns working-tree files into records for `fangorn add`.

export interface Staged {
	records: RecordInput[];
	deletes: string[];
}

export interface StageOpts {
	type?: string;
	idColumn?: string;
}

type Row = Record<string, unknown>;

/** RFC 4180 CSV → one object per row, keyed by the header. */
export function parseCsv(text: string): Record<string, string>[] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quoted) {
			if (c === '"' && text[i + 1] === '"') field += text[++i];
			else if (c === '"') quoted = false;
			else field += c;
		} else if (c === '"') quoted = true;
		else if (c === ",") {
			row.push(field);
			field = "";
		} else if (c === "\n" || c === "\r") {
			if (c === "\r" && text[i + 1] === "\n") i++;
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
		} else field += c;
	}
	if (field || row.length) rows.push([...row, field]);
	const [header = [], ...body] = rows;
	return body.map((r) =>
		Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])),
	);
}

// Record ids are printable ASCII without spaces.
const safeId = (s: string): string => s.replace(/[^\x21-\x7e]/g, "_");

/** Files under `path` (file or dir) as root-relative posix paths; dot entries skipped. */
export function walk(root: string, path: string): string[] {
	const rel = (p: string) => relative(root, p).split(sep).join("/");
	if (!statSync(path).isDirectory()) return [rel(path)];
	return readdirSync(path, { recursive: true, withFileTypes: true })
		.filter((e) => e.isFile())
		.map((e) => rel(join(e.parentPath, e.name)))
		.filter((p) => !p.split("/").some((s) => s.startsWith(".")));
}

/** One file → records. null for binary files (no text to stage). */
export function fileToRecords(
	root: string,
	rel: string,
	opts: StageOpts,
): Staged | null {
	const bytes = readFileSync(join(root, rel));
	if (bytes.subarray(0, 8192).includes(0)) return null;
	const text = bytes.toString("utf-8");
	const ext = extname(rel).toLowerCase();
	const type = opts.type ?? basename(rel, extname(rel));
	const idCol = opts.idColumn ?? "id";

	const many = (rows: Row[]): Staged => ({
		records: rows.map((payload, i) => {
			const id = payload[idCol];
			const usable = typeof id === "string" || typeof id === "number";
			return {
				id: safeId(
					usable && id !== "" ? String(id) : `${rel}#${(i + 1).toString()}`,
				),
				type,
				payload,
			};
		}),
		deletes: [],
	});

	if (ext === ".csv") return many(parseCsv(text));
	if (ext === ".jsonl" || ext === ".ndjson")
		return many(
			text
				.split("\n")
				.filter((l) => l.trim())
				.map((l) => JSON.parse(l) as Row),
		);
	if (ext === ".json") {
		const data = JSON.parse(text) as unknown;
		if (Array.isArray(data)) return many(data as Row[]);
		const obj = data as Partial<Staged>;
		if (Array.isArray(obj.records) || Array.isArray(obj.deletes))
			return { records: obj.records ?? [], deletes: obj.deletes ?? [] };
		return {
			records: [{ id: safeId(rel), type, payload: data as Row }],
			deletes: [],
		};
	}
	return {
		records: [
			{
				id: safeId(rel),
				type: opts.type ?? "file",
				payload: { path: rel, text },
			},
		],
		deletes: [],
	};
}
