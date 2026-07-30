import { readdirSync, readFileSync, statSync } from "fs";
import { basename, extname, join } from "path";
import { Stats } from "fs";

export interface FileFacade {
    /** The full filename including extension (e.g., "notes.md") */
    name: string;
    /** The filename without extension, used as the default ID (e.g., "notes") */
    nameNoExt: string;
    /** The file extension in lowercase, including the dot (e.g., ".md") */
    ext: string;
    /** The absolute or relative path to the file */
    path: string;
    /** Reads the file and returns its content as a UTF-8 string */
    readText: () => string;
    /** Reads the file and returns its raw Buffer data */
    readBuffer: () => Buffer;
    /** Retrieves file system metadata stats for the file */
    stat: () => Stats;
}

export interface ProcessorResult {
    /** The entity type/tag for the graph vertex (defaults to "asset") */
    tag?: string;
    /** Custom metadata object attached to the vertex */
    payload?: Record<string, unknown>;
    /** An array of target vertex IDs that this file links to */
    links?: string[];
}

export type AssetProcessor = (file: FileFacade) => ProcessorResult;

export interface BuildAssetGraphOptions {
    /** A dictionary mapping lowercase file extensions (e.g., ".md") to processor functions */
    processors?: Record<string, AssetProcessor>;
    /**
     * Called for every file whose processor threw, instead of failing the whole
     * build. Omit it and the first failure propagates — a half-built graph would
     * otherwise commit as if it were complete.
     */
    onError?: (err: Error, file: FileFacade) => void;
}

export interface Vertex {
    id: string;
    tag: string;
    payload: Record<string, unknown>;
}

export interface Edge {
    rel: string;
    from: string;
    to: string;
}

export interface CommitFileGraph {
    vertices: Vertex[];
    edges: Edge[];
}

/**
 * Traverses a directory, parses files based on their extensions, 
 * and generates a strictly validated Fangorn-compliant commit graph.
 */
export function buildAssetGraph(
    dir: string,
    options: BuildAssetGraphOptions = {}
): CommitFileGraph {
    const { processors = {}, onError } = options;

    // 1. Read the directory and discover all potential files
    const rawFiles: string[] = readdirSync(dir);

    // Pre-calculate valid IDs based on filenames (minus extensions)
    const getId = (f: string): string => basename(f, extname(f));
    const validIds = new Set<string>(rawFiles.map(getId));

    const vertices: Vertex[] = [];
    const edges = new Set<string>();

    // 2. Process every file based on its extension
    for (const f of rawFiles) {
        const ext = extname(f).toLowerCase();
        // Skip files the developer hasn't defined a processor for. Calling an
        // undefined processor throws a TypeError indistinguishable from a
        // genuine processing failure.
        if (!Object.hasOwn(processors, ext)) continue;
        const processor = processors[ext];

        const fromId = getId(f);
        const fullPath = join(dir, f);

        // Provide a nice API facade so the dev doesn't deal with 'fs'
        const fileFacade: FileFacade = {
            name: f,
            nameNoExt: fromId,
            ext,
            path: fullPath,
            readText: () => readFileSync(fullPath, "utf-8"),
            readBuffer: () => readFileSync(fullPath),
            stat: () => statSync(fullPath)
        };

        try {
            // Run the developer's custom logic for this asset type
            const { tag = "asset", payload = {}, links = [] } = processor(fileFacade);

            // Add the vertex
            vertices.push({ id: fromId, tag, payload });

            // Process and sanitize links emitted by the processor
            for (const toId of links) {
                // Ensure no self-links, and the target target actually exists in the graph
                if (toId && fromId !== toId && validIds.has(toId)) {
                    edges.add(JSON.stringify({ rel: "links", from: fromId, to: toId }));
                }
            }
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            if (!onError) {
                throw new Error(`failed to process ${fullPath}: ${error.message}`, {
                    cause: error,
                });
            }
            onError(error, fileFacade);
        }
    }

    return {
        vertices,
        edges: Array.from(edges).map((e) => JSON.parse(e) as Edge)
    };
}

/**
 * Utility helper to scan markdown strings for standard markdown links or wikilinks.
 */
export function extractMarkdownLinks(content: string): string[] {
    const LINK_REGEX = /\]\(([^)\s]+?\.md)(?:#[^)]*)?\)|\[\[([^\]|#]+?)(?:[|#][^\]]*)?\]\]/g;
    const links: string[] = [];

    // Helper to turn "docs/intro.md" into "intro"
    const convertToId = (str: string): string => basename(str, extname(str));

    for (const match of content.matchAll(LINK_REGEX)) {
        // match[1] = standard link target, match[2] = wikilink target
        const rawTarget = match[1]; 
        // ?? match[2];
        if (rawTarget) {
            links.push(convertToId(rawTarget));
        }
    }

    return links;
}

export const buildMarkdownGraph = (dir: string) => {
    return buildAssetGraph(dir, {
        processors: {
            ".md": (file) => ({
                tag: "doc",
                // TypeScript automatically infers this as Record<string, unknown>
                payload: { content: file.readText() },
                links: extractMarkdownLinks(file.readText())
            })
        }
    });
}