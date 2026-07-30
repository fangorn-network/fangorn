import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildAssetGraph, buildMarkdownGraph } from "./index.js";

describe("buildAssetGraph", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fangorn-harness-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const write = (name: string, content: string) => {
		writeFileSync(join(dir, name), content, "utf-8");
	};

	it("skips files with no processor instead of failing them", () => {
		write("a.md", "# a");
		write("logo.png", "not markdown");

		const graph = buildMarkdownGraph(dir);

		expect(graph.vertices.map((v) => v.id)).toEqual(["a"]);
	});

	it("propagates a processor failure, naming the file", () => {
		write("a.md", "# a");

		expect(() =>
			buildAssetGraph(dir, {
				processors: {
					".md": () => {
						throw new Error("bad frontmatter");
					},
				},
			}),
		).toThrow(/a\.md: bad frontmatter/);
	});

	it("reports failures to onError and keeps going", () => {
		write("good.md", "# good");
		write("bad.md", "# bad");
		const failures: string[] = [];

		const graph = buildAssetGraph(dir, {
			processors: {
				".md": (file) => {
					if (file.name === "bad.md") throw new Error("bad frontmatter");
					return { tag: "doc", payload: {} };
				},
			},
			onError: (err, file) => failures.push(`${file.name}: ${err.message}`),
		});

		expect(failures).toEqual(["bad.md: bad frontmatter"]);
		expect(graph.vertices.map((v) => v.id)).toEqual(["good"]);
	});
});
