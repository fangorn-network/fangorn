import { Blockstore } from 'interface-blockstore';
import * as Batch from '@web3-storage/pail/batch';
import { entries as pailEntries } from '@web3-storage/pail';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import * as dagCbor from '@ipld/dag-cbor';
import * as Digest from 'multiformats/hashes/digest';
import { type Address, type Hash, type Hex } from "viem";
import { DataRegistryClient } from '../contracts';
import { ShardBlock } from '@web3-storage/pail/shard';

export type SchemaID = string;
export type RelationLabel = string;
export type NamespaceID = string;

export interface Vertex {
    schemaId: SchemaID;
    payload: Record<string, any>;
}

export interface Edge {
    sourceCid: string;
    relation: RelationLabel;
    targetCid: string;
}

export interface VertexSchema {
    id: SchemaID;
    requiredFields: string[];
}

export interface EdgeSchema {
    sourceSchema: SchemaID;
    relation: RelationLabel;
    targetSchema: SchemaID;
}

export interface CommitObject {
    pailRoot: CID;
    parents: CID[];
    timestamp: number;
    message: string;
}

export interface NamespaceContents {
    vertices: { cid: string; schemaId: SchemaID; payload: Record<string, any> }[];
    edges: Edge[];
}

/** Net change to one namespace between two on-chain roots (see `namespaceDiff`). */
export interface NamespaceDiff {
    /** Vertices new or re-pointed vs. the old root, decoded to their payloads. */
    addedVertices: NamespaceContents['vertices'];
    /** Edges new vs. the old root. */
    addedEdges: Edge[];
    /** CIDs of vertices present at the old root but gone at the new one. */
    removedVertexCids: string[];
    /** Edges present at the old root but gone at the new one. */
    removedEdges: Edge[];
}

// const ZERO_BYTES32: Hex = "0x0000000000000000000000000000000000000000000000000000000000000000";

// function cidToBytes32(cid: CID): Hex {
//     if (cid.multihash.code !== 0x12) {
//         throw new Error("Fangorn Engine strictly requires SHA-256 multihash profiles.");
//     }
//     return bytesToHex(cid.multihash.digest);
// }

// function bytes32ToCid(hex: Hex): CID<unknown, number, number, 1> { // Force literal version 1 type
//     const rawDigest = hexToBytes(hex);
//     const normalizedDigest = new Uint8Array(rawDigest);

//     const multihash = Digest.create(
//         0x12,
//         normalizedDigest
//     );

//     return CID.createV1(dagCbor.code, multihash) as CID<unknown, number, number, 1>;
// }

export class MetagraphRegistry {
    private vertexSchemas = new Map<string, VertexSchema>();
    private edgeSchemas = new Set<string>();

    public registerVertex(namespace: NamespaceID, schema: VertexSchema): void {
        this.vertexSchemas.set(`${namespace}|${schema.id}`, schema);
    }

    public hasVertexSchema(namespace: NamespaceID, schemaId: SchemaID): boolean {
        return this.vertexSchemas.has(`${namespace}|${schemaId}`);
    }

    public registerEdge(namespace: NamespaceID, rule: EdgeSchema): void {
        this.edgeSchemas.add(`${namespace}|${rule.sourceSchema}|${rule.relation}|${rule.targetSchema}`);
    }

    public hasEdgeSchema(namespace: NamespaceID, sourceSchema: SchemaID, relation: RelationLabel, targetSchema: SchemaID): boolean {
        return this.edgeSchemas.has(`${namespace}|${sourceSchema}|${relation}|${targetSchema}`);
    }

    public validateVertex(namespace: NamespaceID, schemaId: SchemaID, payload: Record<string, any>): boolean {
        const schema = this.vertexSchemas.get(`${namespace}|${schemaId}`);
        if (!schema) return false;
        return schema.requiredFields.every(field => field in payload);
    }

    public validateEdge(namespace: NamespaceID, sourceSchema: SchemaID, relation: RelationLabel, targetSchema: SchemaID): boolean {
        return this.edgeSchemas.has(`${namespace}|${sourceSchema}|${relation}|${targetSchema}`);
    }
}

const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000';

/** One line of a commit's diff against its first parent. */
export interface CommitDiff {
    message: string;
    parents: string[];
    timestamp: number;
    pailRoot: string;
    /** namespaced keys (`<ns>/v/...`, `<ns>/e/...`) whose value is new or changed vs. the parent. */
    added: string[];
    /** namespaced keys present in the parent but gone in this commit. */
    removed: string[];
}

export class FangornEngine {
    constructor(
        private blockstore: Blockstore<any, any, any, any, any, any, any, any>,
        private metagraph: MetagraphRegistry,
        private registryClient: DataRegistryClient
    ) { }

    private async encodeBlock(obj: any): Promise<{ cid: CID; bytes: Uint8Array }> {
        const bytes = dagCbor.encode(obj);
        const hash = await sha256.digest(bytes);
        const cid = CID.createV1(dagCbor.code, hash);
        return { cid, bytes };
    }

    private async readBlockBytes(cid: any): Promise<Uint8Array> {
        const chunks: Uint8Array[] = [];
        for await (const chunk of this.blockstore.get(cid) as any) {
            chunks.push(chunk);
        }
        const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
        const flatBytes = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
            flatBytes.set(chunk, offset);
            offset += chunk.length;
        }
        return flatBytes;
    }

    /**
     * Reconstructs the CID a commit's raw digest hex refers to. The contract only
     * stores the bare 32-byte sha256 digest (see commitBatch), so rebuilding the
     * CID must wrap that digest directly via Digest.create — hashing it again
     * with sha256.digest() would produce an unrelated CID pointing at nothing.
     */
    private hexToRootCid(hex: string): CID {
        const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
        const rawDigestBytes = Uint8Array.from(Buffer.from(cleanHex, 'hex'));
        const multihash = Digest.create(sha256.code, rawDigestBytes);
        // Construct the exact v1 CID matching Pail's default dag-cbor format (0x71)
        return CID.createV1(0x71, multihash);
    }

    // ── Commit-object layer ──────────────────────────────────────────────────
    //
    // The on-chain head is a *commit* CID digest — never a bare pail root. A
    // commit wraps the pail tree root plus its parents and message, so the whole
    // history is walkable from that single trusted pointer. Every mutation, be it
    // the immediate `upload` path or the git `commit`+`push` split, advances the
    // head to a new commit that parents the previous one.

    /** Reconstruct the publisher's current on-chain head as a commit CID, or null if none. */
    async resolveHeadCommit(publisher: Address): Promise<CID | null> {
        const currentHead = await this.registryClient.getNamespaceHead(publisher);
        if (!currentHead || currentHead === ZERO_BYTES32) return null;
        return this.hexToRootCid(currentHead);
    }

    /** Read and decode a commit object by CID. */
    async getCommit(commitCid: CID): Promise<CommitObject> {
        const decoded = dagCbor.decode(await this.readBlockBytes(commitCid)) as any;
        return {
            pailRoot: decoded.pailRoot as CID,
            parents: (decoded.parents ?? []) as CID[],
            timestamp: decoded.timestamp as number,
            message: decoded.message as string,
        };
    }

    /** Resolve the pail tree root behind the publisher's on-chain head commit, or null. */
    private async resolvePailRoot(publisher: Address): Promise<CID | null> {
        const commitCid = await this.resolveHeadCommit(publisher);
        if (!commitCid) return null;
        return (await this.getCommit(commitCid)).pailRoot;
    }

    /**
     * Open a Pail write batch over `basePailRoot` (or a fresh empty tree when
     * null). Pure/local — never reads the chain, so callers control exactly which
     * historical root a new commit builds on (on-chain tip vs. a local HEAD).
     */
    async openBatch(basePailRoot: CID | null): Promise<any> {
        let activePailRoot: any;
        if (basePailRoot) {
            activePailRoot = basePailRoot;
        } else {
            const init = await ShardBlock.create();
            await this.blockstore.put(init.cid as any, init.bytes);
            activePailRoot = init.cid;
        }

        const pailStorageReader = {
            get: async (cid: any) => {
                try {
                    return { cid, bytes: await this.readBlockBytes(cid) };
                } catch (error: any) {
                    if (cid.toString() === activePailRoot.toString()) {
                        const freshInit = await ShardBlock.create();
                        return { cid: freshInit.cid, bytes: freshInit.bytes };
                    }
                    throw error;
                }
            }
        };

        return Batch.create(pailStorageReader as any, activePailRoot);
    }

    /**
     * Open a batch that continues the publisher's on-chain head (immediate-write
     * path). Returns the base commit CID and raw head hex so the caller can parent
     * the next commit and pass the expected old root to the on-chain CAS.
     */
    async createBatch(publisher: Address): Promise<{ batch: any; contractHeadHex: string; baseCommitCid: CID | null }> {
        const contractHeadHex = (await this.registryClient.getNamespaceHead(publisher)) || ZERO_BYTES32;
        const baseCommitCid = contractHeadHex === ZERO_BYTES32 ? null : this.hexToRootCid(contractHeadHex);
        const basePailRoot = baseCommitCid ? (await this.getCommit(baseCommitCid)).pailRoot : null;
        const batch = await this.openBatch(basePailRoot);
        return { batch, contractHeadHex, baseCommitCid };
    }

    public async stageVertex(
        batch: any,
        namespace: NamespaceID,
        schemaId: SchemaID,
        payload: Record<string, any>
    ): Promise<string> {

        if (!this.metagraph.validateVertex(namespace, schemaId, payload)) {
            throw new Error(`Schema violation for vertex type [${schemaId}] in namespace [${namespace}]`);
        }

        const vertexObj: Vertex = { schemaId, payload };
        const { cid, bytes } = await this.encodeBlock(vertexObj);

        await this.blockstore.put(cid, bytes);

        const vertexStringId = cid.toString();
        const partitionedKey = `${namespace}/v/${vertexStringId}`;
        await batch.put(partitionedKey, cid);

        return vertexStringId;
    }

    public async stageEdge(
        batch: any,
        namespace: NamespaceID,
        edge: Edge,
        sourceSchema: SchemaID,
        targetSchema: SchemaID
    ): Promise<void> {
        if (!this.metagraph.validateEdge(namespace, sourceSchema, edge.relation, targetSchema)) {
            throw new Error(`Invalid structural link relation [${edge.relation}] in namespace [${namespace}]`);
        }

        const { cid, bytes } = await this.encodeBlock(edge);
        await this.blockstore.put(cid, bytes);

        const partitionedKey = `${namespace}/e/${edge.sourceCid}|${edge.relation}|${edge.targetCid}`;
        await batch.put(partitionedKey, cid);
    }

    /**
     * Seal a write batch into a new commit *locally*: flatten the pail tree, then
     * wrap its root in a CommitObject parented on `parents`. Writes blocks to the
     * blockstore but does NOT touch the chain — the git `commit` step. The
     * returned commit isn't on-chain until pushCommit() settles it.
     */
    async sealBatch(batch: any, parents: CID[], message: string): Promise<{ commitCid: CID; pailRoot: CID }> {
        const collections = await Batch.commit(batch);
        if (collections.additions && Array.isArray(collections.additions)) {
            for (const block of collections.additions) {
                await this.blockstore.put(block.cid as any, block.bytes);
            }
        }
        const pailRoot = collections.root as CID;
        const commitCid = await this.writeCommit(pailRoot, parents, message);
        return { commitCid, pailRoot };
    }

    /** Build, encode and store a CommitObject block; returns its CID. */
    private async writeCommit(pailRoot: CID, parents: CID[], message: string): Promise<CID> {
        const commitObj: CommitObject = { pailRoot, parents, timestamp: Date.now(), message };
        const { cid, bytes } = await this.encodeBlock(commitObj);
        await this.blockstore.put(cid, bytes);
        return cid;
    }

    /** Upload every block written locally since the last flush to the remote backend. */
    async flush(): Promise<void> {
        if (typeof (this.blockstore as any).flush === 'function') {
            await (this.blockstore as any).flush();
        }
    }

    /**
     * Settle a local commit as the publisher's on-chain head — the permissioned,
     * git `push` step. Flushes pending blocks to remote storage first (so the
     * commit resolves for anyone reading the chain), then does the compare-and-swap
     * against the current head. Unless `force`, the on-chain head must be an
     * ancestor of `commitCid` (fast-forward only).
     */
    async pushCommit(publisher: Address, commitCid: CID, opts?: { force?: boolean }): Promise<{ txHash: Hash; onChainTip: CID }> {
        await this.flush();

        const onChainHex = (await this.registryClient.getNamespaceHead(publisher)) || ZERO_BYTES32;
        const onChainCommit = onChainHex === ZERO_BYTES32 ? null : this.hexToRootCid(onChainHex);

        if (!opts?.force && onChainCommit && onChainCommit.toString() !== commitCid.toString()) {
            if (!(await this.isAncestor(onChainCommit, commitCid))) {
                throw new Error(
                    'non-fast-forward: the on-chain tip is not an ancestor of this commit — clone/rebuild onto the current tip, or push with force.'
                );
            }
        }

        const newRootHex = `0x${Buffer.from(commitCid.multihash.digest).toString('hex')}` as Hex;
        const txHash = await this.registryClient.commitStateRoot(onChainHex as `0x${string}`, newRootHex);
        return { txHash, onChainTip: commitCid };
    }

    /** Walk the first-parent chain from `tip` toward the root, newest first. */
    async *walkParents(tip: CID, max?: number): AsyncGenerator<{ cid: CID; commit: CommitObject }> {
        let cursor: CID | null = tip;
        for (let n = 0; cursor && (max === undefined || n < max); n++) {
            const commit = await this.getCommit(cursor);
            yield { cid: cursor, commit };
            cursor = commit.parents.length ? (commit.parents[0] as CID) : null;
        }
    }

    /** True if `ancestor` appears on the first-parent chain of `tip`. */
    private async isAncestor(ancestor: CID, tip: CID): Promise<boolean> {
        const target = ancestor.toString();
        for await (const { cid } of this.walkParents(tip)) {
            if (cid.toString() === target) return true;
        }
        return false;
    }

    /** The commit CID string a raw on-chain root hex points at. */
    commitCidFromRootHex(hex: string): string {
        return this.hexToRootCid(hex).toString();
    }

    /**
     * Net change to a single namespace between two on-chain roots — the core of
     * the subscription light-client. Resolves the pail tree behind each commit
     * root and diffs only the `<namespace>/` slice, so pushes that touched *other*
     * namespaces of the same publisher produce an empty diff.
     *
     * Diffing root-to-root (rather than walking commits) is deliberately robust:
     * it yields the correct net delta even across a force-push / non-fast-forward
     * reorg — exactly what an index builder needs (which vertices to (re)embed,
     * which to evict). Added vertices are decoded to their payloads; removed items
     * and all edges are recovered from the pail key alone (no extra fetch), since
     * an edge key already encodes `source|relation|target`.
     */
    async namespaceDiff(
        oldRootHex: string | null,
        newRootHex: string,
        namespace: NamespaceID,
    ): Promise<NamespaceDiff> {
        const prefix = `${namespace}/`;
        const pailRootFor = async (rootHex: string) =>
            (await this.getCommit(this.hexToRootCid(rootHex))).pailRoot;

        const before = oldRootHex && oldRootHex !== ZERO_BYTES32
            ? await this.entriesAt(await pailRootFor(oldRootHex), prefix)
            : new Map<string, string>();
        const after = await this.entriesAt(await pailRootFor(newRootHex), prefix);

        const addedVertices: NamespaceContents['vertices'] = [];
        const addedEdges: Edge[] = [];
        const removedVertexCids: string[] = [];
        const removedEdges: Edge[] = [];

        // Keys new or re-pointed vs. `before`.
        for (const [key, cidStr] of after) {
            if (before.get(key) === cidStr) continue;
            if (key.startsWith(`${prefix}v/`)) {
                const decoded = dagCbor.decode(await this.readBlockBytes(CID.parse(cidStr))) as any;
                addedVertices.push({ cid: cidStr, schemaId: decoded.schemaId, payload: decoded.payload });
            } else if (key.startsWith(`${prefix}e/`)) {
                addedEdges.push(this.edgeFromKey(key, prefix));
            }
        }

        // Keys present before and gone now.
        for (const [key, cidStr] of before) {
            if (after.has(key)) continue;
            if (key.startsWith(`${prefix}v/`)) {
                removedVertexCids.push(cidStr);
            } else if (key.startsWith(`${prefix}e/`)) {
                removedEdges.push(this.edgeFromKey(key, prefix));
            }
        }

        return { addedVertices, addedEdges, removedVertexCids, removedEdges };
    }

    /** Recover an Edge from its pail key `<ns>/e/<source>|<relation>|<target>`. */
    private edgeFromKey(key: string, prefix: string): Edge {
        const [sourceCid, relation, targetCid] = key.slice(`${prefix}e/`.length).split('|');
        return { sourceCid, relation, targetCid };
    }

    /** Diff a commit against its first parent, by namespaced pail key. */
    async diffCommit(commitCid: CID): Promise<CommitDiff> {
        const commit = await this.getCommit(commitCid);
        const child = await this.entriesAt(commit.pailRoot);
        const parent = commit.parents.length
            ? await this.entriesAt((await this.getCommit(commit.parents[0] as CID)).pailRoot)
            : new Map<string, string>();

        const added = [...child.entries()].filter(([k, v]) => parent.get(k) !== v).map(([k]) => k);
        const removed = [...parent.keys()].filter(k => !child.has(k));

        return {
            message: commit.message,
            parents: (commit.parents as CID[]).map(c => c.toString()),
            timestamp: commit.timestamp,
            pailRoot: commit.pailRoot.toString(),
            added: added.sort(),
            removed: removed.sort(),
        };
    }

    /** Every content-linked pail key → linked CID string, under an optional prefix. */
    private async entriesAt(pailRoot: CID, prefix = ''): Promise<Map<string, string>> {
        const blocks = { get: async (cid: any) => ({ cid, bytes: await this.readBlockBytes(cid) }) };
        const out = new Map<string, string>();
        for await (const [key, value] of pailEntries(blocks as any, pailRoot as any, { prefix })) {
            const linkCid = CID.asCID(value as any);
            if (linkCid) out.set(key, linkCid.toString());
        }
        return out;
    }

    /**
     * Cheap existence check: does anything (including the bare `sys/init`
     * marker) exist under this namespace prefix yet? Short-circuits on the
     * first entry found instead of decoding the whole namespace, unlike
     * listNamespace (which also skips non-CID values like the marker itself).
     */
    async namespaceExists(namespace: NamespaceID, publisher: Address): Promise<boolean> {
        const rootCid = await this.resolvePailRoot(publisher);
        if (!rootCid) return false;

        const blocks = { get: async (cid: any) => ({ cid, bytes: await this.readBlockBytes(cid) }) };
        const prefix = `${namespace}/`;

        for await (const _entry of pailEntries(blocks as any, rootCid as any, { prefix })) {
            return true;
        }
        return false;
    }

    /** Lists every vertex and edge currently staged under a namespace, resolved from the on-chain root. */
    async listNamespace(namespace: NamespaceID, publisher: Address): Promise<NamespaceContents> {
        const vertices: NamespaceContents['vertices'] = [];
        const edges: Edge[] = [];

        const rootCid = await this.resolvePailRoot(publisher);
        if (!rootCid) return { vertices, edges };

        const blocks = { get: async (cid: any) => ({ cid, bytes: await this.readBlockBytes(cid) }) };
        const prefix = `${namespace}/`;

        for await (const [key, value] of pailEntries(blocks as any, rootCid as any, { prefix })) {
            // Values are CID links except the `sys/init` marker, which stores a literal string.
            const linkCid = CID.asCID(value as any);
            if (!linkCid) continue;

            const decoded = dagCbor.decode(await this.readBlockBytes(linkCid)) as any;
            if (key.startsWith(`${prefix}v/`)) {
                vertices.push({ cid: linkCid.toString(), schemaId: decoded.schemaId, payload: decoded.payload });
            } else if (key.startsWith(`${prefix}e/`)) {
                edges.push(decoded as Edge);
            }
        }

        return { vertices, edges };
    }
}