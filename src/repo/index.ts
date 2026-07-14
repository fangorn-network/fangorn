import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { type Address, type Hex } from "viem";

/**
 * The local working repo — a `.fangorn/` directory, the analogue of `.git/`.
 *
 * It records just enough to identify the on-chain dataset this working copy
 * tracks and where local history currently points:
 *
 *   .fangorn/
 *     config.json   — { name, schemaId, owner }: the (owner, schemaId, name)
 *                     triple that keys the dataset in the DataSource registry.
 *     HEAD          — the CID of the local tip commit, or empty before the first
 *                     commit. This is what `push` compares against the on-chain
 *                     tip, and what the next `commit` uses as its parent.
 *
 * `commit` moves HEAD locally (permissionless). `push` reconciles HEAD with the
 * on-chain ref (the permissioned step). See docs/PROTOCOL.md §5, §7.
 */

export const REPO_DIR = ".fangorn";

export interface RepoConfig {
    /** Dataset name — the human-facing repo name, part of the on-chain key. */
    name: string;
    /** Schema reference as given at init (name or bytes32 id) — used to resolve
     *  the schema shape when building commits. */
    schema: string;
    /** Resolved schema id — the on-chain key component. */
    schemaId: Hex;
    /** Owner address (the wallet that keys the on-chain dataset). */
    owner: Address;
}

export class LocalRepo {
    /** @param root the directory containing `.fangorn/` (the working dir). */
    private constructor(private readonly root: string) {}

    private get dir(): string {
        return join(this.root, REPO_DIR);
    }
    private get configPath(): string {
        return join(this.dir, "config.json");
    }
    private get headPath(): string {
        return join(this.dir, "HEAD");
    }

    /** True if `dir` already contains a `.fangorn/` repo. */
    static exists(root = process.cwd()): boolean {
        return existsSync(join(root, REPO_DIR, "config.json"));
    }

    /**
     * Initialize a new repo in `root`. Throws if one already exists so we never
     * silently clobber an existing HEAD/config.
     */
    static init(config: RepoConfig, root = process.cwd()): LocalRepo {
        const repo = new LocalRepo(root);
        if (existsSync(repo.configPath)) {
            throw new Error(`a Fangorn repo already exists at ${repo.dir}`);
        }
        mkdirSync(repo.dir, { recursive: true });
        writeFileSync(repo.configPath, JSON.stringify(config, null, 2), "utf-8");
        writeFileSync(repo.headPath, "", "utf-8");
        return repo;
    }

    /** Open an existing repo. Throws if there isn't one. */
    static open(root = process.cwd()): LocalRepo {
        const repo = new LocalRepo(root);
        if (!existsSync(repo.configPath)) {
            throw new Error(
                `not a Fangorn repo (no ${REPO_DIR}/ found in ${root}). Run \`fangorn init\`.`,
            );
        }
        return repo;
    }

    config(): RepoConfig {
        return JSON.parse(readFileSync(this.configPath, "utf-8")) as RepoConfig;
    }

    /** Local tip commit CID, or undefined before the first commit. */
    head(): string | undefined {
        const raw = readFileSync(this.headPath, "utf-8").trim();
        return raw.length > 0 ? raw : undefined;
    }

    /** Move the local tip to `cid`. */
    setHead(cid: string): void {
        writeFileSync(this.headPath, cid, "utf-8");
    }
}
