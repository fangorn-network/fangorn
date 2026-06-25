import { describe, it, expect } from "vitest";
import type { Hex, WalletClient } from "viem";
import { SchemaRole, type RegisteredSchema } from "./index.js";
import type { SchemaRegistry } from "../../registries/schema-registry";
import type { MetadataStorage } from "../../providers/storage/types.js";
import type { NodeIdentity } from "./types.js";

const OWNER = "0x00000000000000000000000000000000000000aa" as Hex;

// In-memory storage + registry fakes — enough for SchemaRole.register/get.
function makeRole() {
    const blobs = new Map<string, unknown>();
    const cidByName = new Map<string, string>();
    let n = 0;

    const storage = {
        put: (data: unknown) => {
            const cid = `cid:${(n++).toString()}`;
            blobs.set(cid, data);
            return Promise.resolve(cid);
        },
        get: <T>(cid: string) => Promise.resolve(blobs.get(cid) as T),
    } as unknown as MetadataStorage;

    const idOf = (name: string) => `0x${Buffer.from(name).toString("hex").padEnd(64, "0").slice(0, 64)}` as Hex;
    const registry = {
        registerSchema: (name: string, specCid: string) => {
            cidByName.set(name, specCid);
            return Promise.resolve({ hash: "0x" as Hex, schemaId: idOf(name) });
        },
        schemaId: (name: string) => Promise.resolve(idOf(name)),
        getSchema: (nameOrId: string) =>
            Promise.resolve({ name: nameOrId, specCid: cidByName.get(nameOrId) ?? "", agentId: "", owner: OWNER }),
    } as unknown as SchemaRegistry;

    const walletClient = { account: { address: OWNER } } as unknown as WalletClient;
    return new SchemaRole(registry, storage, walletClient);
}

describe("SchemaRole — Phase 0 identity round-trip", () => {
    const identity: NodeIdentity = { "@id": "placeId", aliases: { gplace: "placeId" } };

    it("returns the identity declaration from register()", async () => {
        const role = makeRole();
        const reg = await role.register({
            name: "business.v1",
            definition: { title: { "@type": "string" }, placeId: { "@type": "string" } },
            identity,
        });
        expect(reg.kind).toBe("resolver");
        expect((reg as Extract<RegisteredSchema, { kind: "resolver" }>).identity).toEqual(identity);
    });

    it("round-trips the identity declaration through register → get", async () => {
        const role = makeRole();
        await role.register({
            name: "business.v1",
            definition: { title: { "@type": "string" }, placeId: { "@type": "string" } },
            identity,
        });
        const got = await role.get("business.v1");
        expect(got?.kind).toBe("resolver");
        expect((got as Extract<RegisteredSchema, { kind: "resolver" }>).identity).toEqual(identity);
    });

    it("leaves identity undefined when none is declared", async () => {
        const role = makeRole();
        await role.register({ name: "plain.v1", definition: { title: { "@type": "string" } } });
        const got = await role.get("plain.v1");
        expect((got as Extract<RegisteredSchema, { kind: "resolver" }>).identity).toBeUndefined();
    });
});
