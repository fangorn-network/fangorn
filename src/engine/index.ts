import { Blockstore } from 'interface-blockstore';
import * as Batch from '@web3-storage/pail/batch';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import * as dagCbor from '@ipld/dag-cbor';
import * as Digest from 'multiformats/hashes/digest';
import { ShardBlock } from '@web3-storage/pail/shard';
import { type Address, type Hash, type Hex, bytesToHex, hexToBytes } from "viem";
import { DataRegistryClient } from '../contracts';

// Import your newly created contract client wrapper
// import { DataRegistryClient } from "./DataRegistryClient.js"; 

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

// ── Cryptographic Mapping Helpers ───────────────────────────────────────────

const ZERO_BYTES32: Hex = "0x0000000000000000000000000000000000000000000000000000000000000000";

/**
 * Extracts the raw 32-byte SHA-256 digest from a CID instance for on-chain storage.
 */
function cidToBytes32(cid: CID): Hex {
    if (cid.multihash.code !== 0x12) {
        throw new Error("Fangorn Engine strictly requires SHA-256 multihash profiles.");
    }
    return bytesToHex(cid.multihash.digest);
}

/**
 * Hydrates a raw 32-byte contract Hex string back into an authoritative DAG-CBOR CIDv1 object.
 */
function bytes32ToCid(hex: Hex): CID {
    const rawDigest = hexToBytes(hex);
    const normalizedDigest = new Uint8Array(rawDigest);

    // Explicitly build a valid MultihashDigest structure using the library helper
    const multihash = Digest.create(
        0x12, // sha256 identifier code
        normalizedDigest
    );

    return CID.createV1(dagCbor.code, multihash);
}

// ── Metagraph Registry ───────────────────────────────────────────────────────

export class MetagraphRegistry {
    private vertexSchemas = new Map<string, VertexSchema>();
    private edgeSchemas = new Set<string>();

    public registerVertex(namespace: NamespaceID, schema: VertexSchema): void {
        this.vertexSchemas.set(`${namespace}|${schema.id}`, schema);
    }

    public registerEdge(namespace: NamespaceID, rule: EdgeSchema): void {
        this.edgeSchemas.add(`${namespace}|${rule.sourceSchema}|${rule.relation}|${rule.targetSchema}`);
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

// ── The Unified Fangorn Multi-Tenant Repository ──────────────────────────────

export class FangornEngine {
    constructor(
        private blockstore: Blockstore,
        private metagraph: MetagraphRegistry,
        private registryClient: DataRegistryClient
    ) { }

    private async encodeBlock(obj: any): Promise<{ cid: CID; bytes: Uint8Array }> {
        const bytes = dagCbor.encode(obj);
        const hash = await sha256.digest(bytes);
        const cid = CID.createV1(dagCbor.code, hash);
        return { cid, bytes };
    }

    /**
     * Pulls the authoritative timeline anchor from the smart contract, 
     * resolves the local database transaction state, and generates a mutations batch.
     */
    public async createBatch(publisher: Address): Promise<{ batch: any; contractHeadHex: Hex }> {
        const fetcherAdapter = {
            get: async (link: any) => {
                const cidKey = CID.asCID(link) || CID.create(link.version, link.code, link.multihash);
                try {
                    const bytes = await this.blockstore.get(cidKey);
                    return { cid: cidKey, bytes };
                } catch {
                    return undefined;
                }
            }
        };

        // 1. Fetch authoritative head from smart contract state machine
        const contractHeadHex = await this.registryClient.getNamespaceHead(publisher);
        let activePailRoot: CID;

        if (contractHeadHex === ZERO_BYTES32) {
            // Namespace is brand new: initialize a fresh local Pail shard tracking matrix
            const initialShard = await ShardBlock.create();
            await this.blockstore.put(initialShard.cid as any, initialShard.bytes);
            activePailRoot = CID.parse(initialShard.cid.toString());
        } else {
            // Namespace exists: Rehydrate the commit block from your local store to find its Pail root
            const commitCid = bytes32ToCid(contractHeadHex);
            const rawCommitBytes = await this.blockstore.get(commitCid);
            if (!rawCommitBytes) {
                throw new Error(`Data Desynced: Commit block context [${commitCid.toString()}] missing from blockstore.`);
            }
            const commitData = dagCbor.decode(rawCommitBytes) as CommitObject;
            activePailRoot = CID.parse(commitData.pailRoot.toString());
        }

        const batch = await Batch.create(fetcherAdapter as any, activePailRoot as any);
        return { batch, contractHeadHex };
    }

    public async stageVertex(
        batch: any,
        namespace: NamespaceID,
        schemaId: SchemaID,
        payload: Record<string, any>
    ): Promise<string> {
        if (!this.metagraph.validateVertex(namespace, schemaId, payload)) {
            console.log('uhoh')
            throw new Error(`Schema violation for vertex type [${schemaId}] in namespace [${namespace}]`);
        }

        const vertexObj: Vertex = { schemaId, payload };
        // blocks are CBOR-DAG encoded IPLD blocks
        const { cid, bytes } = await this.encodeBlock(vertexObj);

        console.log('the cid')
        console.log(cid);

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
     * Executes the local IPLD commit, persists structural block deltas,
     * updates the lineage DAG metadata block, and commits the state root to the blockchain via CAS protection.
     */
    public async commitBatch(
        batch: any,
        publisher: Address,
        contractHeadHex: Hex,
        message: string
    ): Promise<{ commitCid: CID; txHash: Hash }> {
        // 1. Commit modifications down the local key-space index trie
        const { root, additions } = await batch.commit();

        for (const block of additions) {
            await this.blockstore.put(block.cid, block.bytes);
        }

        // 2. Assemble historical lineage tracking meta-block
        const parentHistoryList = contractHeadHex !== ZERO_BYTES32 ? [bytes32ToCid(contractHeadHex)] : [];
        const commitObj: CommitObject = {
            pailRoot: root,
            parents: parentHistoryList,
            timestamp: Date.now(),
            message
        };

        const { cid: commitCid, bytes: commitBytes } = await this.encodeBlock(commitObj);
        await this.blockstore.put(commitCid, commitBytes);

        // 3. Convert your unique commit signature into an EVM compatible 32-byte array
        const newRootHex = cidToBytes32(commitCid);

        // 4. Fire the CAS validation transaction targeting the Arbitrum execution frame
        const txHash = await this.registryClient.commitStateRoot(contractHeadHex, newRootHex);

        return { commitCid, txHash };
    }
}