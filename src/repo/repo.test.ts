import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { type Address, type Hex } from "viem";
import { LocalRepo, REPO_DIR } from "./index.js";

const CONFIG = {
    name: "rusty-anchor",
    schema: "places.v1",
    schemaId: ("0x" + "11".repeat(32)) as Hex,
    owner: "0x2222222222222222222222222222222222222222" as Address,
};

describe("LocalRepo", () => {
    let root: string;
    beforeEach(() => { root = mkdtempSync(join(tmpdir(), "fangorn-repo-")); });
    afterEach(() => { rmSync(root, { recursive: true, force: true }); });

    it("init creates .fangorn with config and an empty HEAD", () => {
        const repo = LocalRepo.init(CONFIG, root);
        expect(existsSync(join(root, REPO_DIR, "config.json"))).toBe(true);
        expect(repo.config()).toEqual(CONFIG);
        expect(repo.head()).toBeUndefined();
        expect(LocalRepo.exists(root)).toBe(true);
    });

    it("init refuses to clobber an existing repo", () => {
        LocalRepo.init(CONFIG, root);
        expect(() => LocalRepo.init(CONFIG, root)).toThrow(/already exists/);
    });

    it("open throws when there is no repo", () => {
        expect(() => LocalRepo.open(root)).toThrow(/not a Fangorn repo/);
    });

    it("setHead / head persist the tip across reopen", () => {
        LocalRepo.init(CONFIG, root);
        const repo = LocalRepo.open(root);
        repo.setHead("bafyCommit1");
        expect(repo.head()).toBe("bafyCommit1");
        // reopen to prove it hit disk, not just memory
        expect(LocalRepo.open(root).head()).toBe("bafyCommit1");
    });
});
