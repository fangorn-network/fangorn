import { readFileSync, readdirSync, realpathSync, statSync } from "fs";
import { basename, extname, isAbsolute, join, relative, sep } from "path";
import type { RecordInput } from "../engine/index.js";

// Turns working-tree files into records for `fangorn add`.

export interface Staged {
	records: RecordInput[];
	deletes: string[];
	/** Staging-only provenance. Older indexes have no source information. */
	sources?: Record<string, string>;
}

export interface StageOpts {
	type?: string;
	idColumn?: string;
}

type Row = Record<string, unknown>;

/** RFC 4180 CSV → one object per row, keyed by the header. Blank lines are skipped. */
export function parseCsv(text: string): Record<string, string>[] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	// Anything on this line yet: a lone `""` is a row, an empty line is not.
	let dirty = false;
	const endRow = () => {
		if (dirty) rows.push([...row, field]);
		row = [];
		field = "";
		dirty = false;
	};
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quoted) {
			if (c === '"' && text[i + 1] === '"') field += text[++i];
			else if (c === '"') quoted = false;
			else field += c;
		} else if (c === '"') quoted = dirty = true;
		else if (c === ",") {
			row.push(field);
			field = "";
			dirty = true;
		} else if (c === "\n" || c === "\r") {
			if (c === "\r" && text[i + 1] === "\n") i++;
			endRow();
		} else {
			field += c;
			dirty = true;
		}
	}
	// Silently eating the rest of the file into one field would publish it mangled.
	if (quoted) throw new Error("unterminated quoted field");
	endRow();
	const [header = [], ...body] = rows;
	const dup = header.find((h, i) => header.indexOf(h) !== i);
	if (dup !== undefined)
		throw new Error(`duplicate column ${JSON.stringify(dup)}`);
	return body.map((r, n) => {
		if (r.slice(header.length).some(Boolean))
			throw new Error(
				`row ${(n + 1).toString()} has more fields than the header`,
			);
		return Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""]));
	});
}

// Record ids are printable ASCII without spaces.
const safeId = (s: string): string => s.replace(/[^\x21-\x7e]/g, "_");

/**
 * Files under `path` (file or dir) as sorted root-relative posix paths. Dot entries are
 * skipped, and symlinks inside a directory are not followed (no escaping the repo, no cycles).
 * Throws for a path outside `root`, judged by real paths: a named symlink, or a symlinked
 * ancestor, that leads out of the repo is outside it.
 */
export function walk(root: string, path: string): string[] {
	const realRoot = realpathSync(root);
	const real = realpathSync(path);
	const rel = (p: string) => relative(realRoot, p).split(sep).join("/");
	const top = rel(real);
	if (top === ".." || top.startsWith("../") || isAbsolute(top))
		throw new Error(`${path} is outside the repo at ${root}`);
	const out: string[] = [];
	const visit = (dir: string) => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, e.name);
			if (e.isDirectory()) visit(p);
			else if (e.isFile()) out.push(rel(p));
		}
	};
	if (statSync(real).isDirectory()) visit(real);
	else out.push(top);
	return out.filter((p) => !p.split("/").some((s) => s.startsWith("."))).sort();
}

/** One file → records. null for binary files (no text to stage). */
export function fileToRecords(
	root: string,
	rel: string,
	opts: StageOpts,
): Staged | null {
	const bytes = readFileSync(join(root, rel));
	if (bytes.subarray(0, 8192).includes(0)) return null;
	const text = bytes.toString("utf-8").replace(/^\uFEFF/, "");
	const ext = extname(rel).toLowerCase();
	const type = opts.type ?? basename(rel, extname(rel));
	const idCol = opts.idColumn ?? "id";

	const many = (rows: Row[]): Staged => ({
		records: rows.map((payload, i) => {
			const raw = payload as unknown; // JSON rows are whatever the file holds
			if (typeof raw !== "object" || raw === null || Array.isArray(raw))
				throw new Error(`row ${(i + 1).toString()} is not an object`);
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
		if (Array.isArray(obj.records) || Array.isArray(obj.deletes)) {
			const records = obj.records ?? [];
			const deletes = obj.deletes ?? [];
			// A data file that happens to have a `records` key must not pass for a commit file.
			if (
				!records.every(
					(r) =>
						typeof (r as Partial<RecordInput> | null)?.type === "string" &&
						typeof r.payload === "object" &&
						(r.id === undefined || typeof r.id === "string"),
				) ||
				!deletes.every((d) => typeof d === "string")
			)
				throw new Error(
					'has "records"/"deletes" but is not a commit file ({"records":[{"id","type","payload"}],"deletes":["id"]})',
				);
			return { records, deletes };
		}
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

/**
 * `fangorn add`: stage the files under `paths` (absolute) on top of `staged`. Re-adding
 * replaces staged records with the same ids. Throws, naming the file, if one fails to
 * parse or two sources map to one record id; nothing is staged then.
 */
export function addPaths(
	root: string,
	paths: string[],
	opts: StageOpts,
	staged: Staged,
): { staged: Staged; added: string[]; skipped: string[]; n: number } {
	const added: string[] = [];
	const skipped: string[] = [];
	const sources = new Map(Object.entries(staged.sources ?? {}));
	const stagedIds = new Set(staged.records.map((r) => r.id));
	let n = 0;
	for (const rel of [...new Set(paths.flatMap((p) => walk(root, p)))]) {
		let got: Staged | null;
		try {
			got = fileToRecords(root, rel, opts);
		} catch (e) {
			throw new Error(`${rel}: ${(e as Error).message}`);
		}
		if (!got) {
			skipped.push(rel);
			continue;
		}
		const seen = new Set<string>();
		for (const { id } of got.records) {
			if (id === undefined) continue;
			const other = sources.get(id);
			if (other === undefined && stagedIds.has(id))
				throw new Error(
					`staged record ${JSON.stringify(id)} has an unknown source; commit it or unstage it with fangorn rm before replacing it`,
				);
			// ids are made id-safe (spaces, non-ASCII → _), so distinct names can meet
			if (seen.has(id))
				throw new Error(
					`record id ${JSON.stringify(id)} comes from two rows of ${rel}; give each record its own id`,
				);
			if (other !== undefined && other !== rel)
				throw new Error(
					`record id ${JSON.stringify(id)} comes from both ${other} and ${rel}; give each record its own id or rename the file`,
				);
			seen.add(id);
			sources.set(id, rel);
		}
		const ids = new Set(got.records.map((r) => r.id));
		staged = {
			records: staged.records
				.filter((r) => !r.id || !ids.has(r.id))
				.concat(got.records),
			deletes: staged.deletes.filter((d) => !ids.has(d)).concat(got.deletes),
		};
		n += got.records.length + got.deletes.length;
		added.push(`${rel} (${got.records.length.toString()} record(s))`);
	}
	return {
		staged: { ...staged, sources: Object.fromEntries(sources) },
		added,
		skipped,
		n,
	};
}
