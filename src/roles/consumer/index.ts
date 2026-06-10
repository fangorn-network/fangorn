import { type Address, type Hex, type WalletClient, encodePacked, keccak256 } from "viem";
import { type Identity } from "@semaphore-protocol/identity";
import { DataSourceRegistry } from "../../registries/datasource-registry";
import { SettlementRegistry } from "../../registries/settlement-registry";
import {
    ClaimParams,
    ClaimResult,
    FetchParams,
    FetchResult,
    PurchaseParams,
    PurchaseResult,
} from "./types";
import { Manifest, ManifestEntry, ResolvedHandleField } from "../publisher/types";
import {
    PrepareSettleParams,
    PrepareSettleResult,
    TransferWithAuthParams,
    TransferWithAuthPayload,
} from "../../registries/settlement-registry/types";
import { PinataBackend } from "../../providers/storage";

export class ConsumerRole {
    constructor(
        private readonly dataSourceRegistry: DataSourceRegistry,
        private readonly settlementRegistry: SettlementRegistry,
    ) { }

    async prepareRegister(params: TransferWithAuthParams): Promise<TransferWithAuthPayload> {
        return this.settlementRegistry.prepareTransferWithAuth(params);
    }

    async prepareSettle(params: PrepareSettleParams): Promise<PrepareSettleResult> {
        return this.settlementRegistry.prepareSettle(params);
    }

    // Phase 1: pay + join group
    async register(params: PurchaseParams): Promise<PurchaseResult> {
        const resourceId = this.deriveResourceId(params.owner, params.schemaId, params.name);
        const txHash = await this.settlementRegistry.register({
            resourceId,
            identityCommitment: params.identityCommitment,
            relayerPrivateKey: params.relayerPrivateKey,
            preparedRegister: params.preparedRegister,
        });
        return { txHash, resourceId };
    }

    // Phase 2: prove + claim
    async claim(params: ClaimParams): Promise<ClaimResult> {
        const resourceId = this.deriveResourceId(params.owner, params.schemaId, params.name);
        const { hash, nullifier } = await this.settlementRegistry.settle({
            relayerPrivateKey: params.relayerPrivateKey,
            preparedSettle: params.preparedSettle,
        });
        return { txHash: hash, nullifier, resourceId };
    }

    /**
     * Fetch a handle field's content from the Fangorn access worker.
     *
     * The consumer signs { nullifier, resourceId, objectKey, timestamp } with
     * their stealth address private key. The worker recovers the address,
     * verifies is_settled() on-chain, and proxies the R2 bytes.
     *
     * Plain fields can be read freely via getEntry() without any of this.
     */
    async fetch(params: FetchParams): Promise<FetchResult> {
        const { nullifier, resourceId, objectKey, workerUrl, walletClient } = params
        const timestamp = Math.floor(Date.now() / 1000)

        const msgHash = keccak256(encodePacked(
            ['uint256', 'bytes32', 'string', 'uint64'],
            [BigInt(nullifier), resourceId, objectKey, BigInt(timestamp)]
        ))

        const account = walletClient.account;
        if (!account) throw new Error("walletClient account must be defined")

        const signature = await walletClient.signMessage({
            message: { raw: msgHash },
            account,
        })

        const res = await globalThis.fetch(`${workerUrl}/access`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nullifier, resourceId, objectKey, timestamp, signature }),
        })
        if (!res.ok) {
            const data = (await res.json().catch(() => ({}))) as unknown;

            const message =
                data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
                    ? data.error
                    : res.statusText;

            throw new Error(`Worker fetch failed: ${message}`);
        }
        const buffer = await res.arrayBuffer()
        return {
            data: new Uint8Array(buffer),
            contentType: res.headers.get('Content-Type') ?? 'application/octet-stream',
        }
    }

    async checkManifestExists(who: Address, schemaId: Hex, name: string): Promise<boolean> {
        try {
            const ds = await this.dataSourceRegistry.get(who, schemaId, name);
            return !!ds.manifestCid && ds.manifestCid !== "";
        } catch {
            return false;
        }
    }

    async getEntry(owner: Address, schemaId: Hex, name: string, gateway?: string): Promise<ManifestEntry | undefined> {
        try {
            const ds = await this.dataSourceRegistry.get(owner, schemaId, name);
            if (!ds.manifestCid || ds.manifestCid === "") return undefined;

            const manifest = await PinataBackend.getStatic<Manifest>(ds.manifestCid, gateway);

            manifest.entries.forEach(entry  => {
                if (entry.name === name) return entry;
            });
            return undefined;
        } catch {
            return undefined;
        }
    }

    /**
     * Resolves the handle URI for a specific field
     * and fetches it via the worker in one call.
     */
    async fetchField(
        owner: Address,
        schemaId: Hex,
        name: string,
        field: string,
        nullifier: string,
        walletClient: WalletClient,
    ): Promise<FetchResult> {
        // TODO: entry can be undefined
        const entry = await this.getEntry(owner, schemaId, name)
        if (!entry) throw new Error("Entry not found")

        const fieldValue = entry.fields[field]

        if (!fieldValue || typeof fieldValue !== 'object' || !('@type' in fieldValue)) {
            throw new Error(`Field "${field}" is missing or is not a handle field`)
        }
        if (fieldValue['@type'] !== 'handle') {
            throw new Error(`Field "${field}" is not a handle field. Read it directly from the entry`)
        }
        const handle = fieldValue as ResolvedHandleField;
        const objectKey = parseObjectKey(handle.uri);
        const resourceId = this.deriveResourceId(owner, schemaId, name)
        return this.fetch({
            nullifier,
            resourceId,
            objectKey,
            workerUrl: handle.workerUrl,
            walletClient,
        })
    }

    async isRegistered(
        owner: Address,
        schemaId: Hex,
        name: string,
        identity: Identity,
    ): Promise<boolean> {
        const resourceId = this.deriveResourceId(owner, schemaId, name);
        return this.settlementRegistry.isRegistered(resourceId, identity.commitment);
    }

    private deriveResourceId(owner: Address, schemaId: Hex, name: string): Hex {
        return DataSourceRegistry.resourceId(owner, schemaId, name);
    }
}

function parseObjectKey(uri: string): string {
    if (uri.startsWith('r2://')) return uri.slice('r2://'.length)
    if (uri.startsWith('ipfs://')) return uri.slice('ipfs://'.length)
    return uri
}