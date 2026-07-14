import { buildAssetGraph, extractMarkdownLinks } from "../../index.js";

const buildMarkdownGraph = (dir: string) => {
    return buildAssetGraph(dir, {
        processors: {
            ".md": (file) => ({
                tag: "doc",
                payload: { content: file.readText() },
                links: extractMarkdownLinks(file.readText())
            })
        }
    });
}

// CLI: build-graph.mjs <dir>
if (import.meta.url === `file://${process.argv[1]}`) {
    const dir = process.argv[2] ?? ".";
    process.stdout.write(JSON.stringify(buildMarkdownGraph(dir), null, 2) + "\n");
}
