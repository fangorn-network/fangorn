import {
	type Address,
	type Chain,
	type Hex,
	type WalletClient,
	createWalletClient,
	http,
} from "viem";
import { Identity } from "@semaphore-protocol/identity";
import { arbitrumSepolia, baseSepolia } from "viem/chains";
import { Fangorn } from "../fangorn.js";
import { type AppConfig } from "../config.js";
import {
	type SchemaDefinition,
	type RegisterAgentParams,
	type RegisteredAgent,
} from "../roles/schema/index.js";
import { type PublishRecord } from "../roles/publisher/index.js";
import { SettlementRegistry } from "../registries/settlement-registry/index.js";
import { SettledGadget } from "../modules/gadgets/settledGadget.js";
import { privateKeyToAccount } from "viem/accounts";
import { PrepareSettleResult, TransferWithAuthPayload } from "../registries/settlement-registry/types.js";
import { AgentConfig } from "../types/index.js";

export class TestBed {
	private constructor(
		private readonly delegatorAddress: Address,
		private readonly delegatorFangorn: Fangorn,
		private readonly delegateeFangorn: Fangorn,
		private readonly config: AppConfig,
		private readonly usdcContractAddress: Address,
		private readonly usdcDomainName: string,
		private readonly pinataJwt: string,
	) { }

	/**
	 * Init the testbed client
	 * @param delegatorWalletClient 
	 * @param delegateeWalletClient 
	 * @param jwt 
	 * @param gateway 
	 * @param dataSourceRegistryContractAddress 
	 * @param schemaRegistryContractAddress 
	 * @param settlementRegistryContractAddress 
	 * @param usdcContractAddress 
	 * @param usdcDomainName 
	 * @param rpcUrl 
	 * @param chain 
	 * @param caip2 
	 * @param delegatorPrivateKey 
	 * @returns The testbed client
	 */
	static async init(
		delegatorWalletClient: WalletClient,
		delegateeWalletClient: WalletClient,
		jwt: string,
		gateway: string,
		dataSourceRegistryContractAddress: Hex,
		schemaRegistryContractAddress: Hex,
		settlementRegistryContractAddress: Hex,
		usdcContractAddress: Hex,
		usdcDomainName: string,
		rpcUrl: string,
		chain: string,
		caip2: number,
		delegatorPrivateKey?: Hex,
	): Promise<TestBed> {
		let chainImpl: Chain = arbitrumSepolia;
		if (chain === "baseSepolia") chainImpl = baseSepolia;

		const config: AppConfig = {
			dataSourceRegistryContractAddress,
			schemaRegistryContractAddress,
			settlementRegistryContractAddress,
			chainName: chain,
			chain: chainImpl,
			rpcUrl,
			caip2,
		};

		const agentConfig: AgentConfig | undefined = delegatorPrivateKey
			? { privateKey: delegatorPrivateKey, pinataJwt: jwt }
			: undefined;

		const delegatorFangorn = await Fangorn.create({
			privateKey: (process.env.DELEGATOR_ETH_PRIVATE_KEY ?? "0x0") as Hex,
			storage: { storacha: { "email": "driemworks@fangorn.network" } },
			encryption: { lit: true },
			config,
			domain: "localhost",
			agentConfig,
		});

		const delegateeFangorn = await Fangorn.create({
			privateKey: (process.env.DELEGATEE_ETH_PRIVATE_KEY ?? "0x0") as Hex,
			storage: { storacha: { "readOnly": true } },
			encryption: { lit: true },
			config,
			domain: "localhost",
		});

		if (!delegatorWalletClient.account) throw new Error("Delegator account not found");

		return new TestBed(
			delegatorWalletClient.account.address,
			delegatorFangorn,
			delegateeFangorn,
			config,
			usdcContractAddress,
			usdcDomainName,
			jwt,
		);
	}

	// Schema owner (Alice)

	async registerAgent(params: RegisterAgentParams): Promise<RegisteredAgent> {
		return this.delegatorFangorn.schema.registerAgent(params);
	}

	async registerSchema(
		name: string,
		definition: SchemaDefinition,
		agentId: string,
	): Promise<Hex> {
		const { schemaId } = await this.delegatorFangorn.schema.register({
			name,
			definition,
			agentId,
		});
		return schemaId;
	}

	// Publisher (Bob)

	/**
	 * Upload files encrypted under SettledGadget.
	 *
	 * Each file gets its own resourceId derived from (owner, schemaId, file.tag),
	 * which is baked into the ACC at encryption time. A buyer must complete the
	 * full purchase → claim flow for each specific tag before decrypting.
	 */
	async fileUpload(
		records: PublishRecord[],
		schema: SchemaDefinition,
		schemaId: Hex,
		gateway: string,
		price: bigint,
	): Promise<string> {
		const owner = this.delegatorFangorn.getAddress();

		const { manifestCid } = await this.delegatorFangorn.publisher.upload({
			records,
			schema,
			schemaId,
			gateway,
			gadgetFactory: (tag) => new SettledGadget({
				resourceId: SettlementRegistry.deriveResourceId(owner, schemaId, tag),
				settlementRegistryAddress: this.config.settlementRegistryContractAddress,
				chainName: this.config.chainName,
				pinataJwt: this.pinataJwt,
			}),
		}, price);

		return manifestCid;
	}

	// Consumer Phase 1: purchase/register

	async prepareRegister(
		burnerPrivateKey: Hex,
		paymentRecipient: Address,
		amount: bigint,
	): Promise<TransferWithAuthPayload> {
		return this.delegateeFangorn.consumer.prepareRegister({
			burnerPrivateKey,
			paymentRecipient,
			amount,
			usdcAddress: this.usdcContractAddress,
			usdcDomainName: this.usdcDomainName,
			usdcDomainVersion: "2",
		});
	}

	async register(
		owner: Address,
		schemaId: Hex,
		tag: string,
		identityCommitment: bigint,
		relayerPrivateKey: Hex,
		preparedRegister: TransferWithAuthPayload,
	): Promise<Hex> {
		const { txHash } = await this.delegateeFangorn.consumer.register({
			owner,
			schemaId,
			tag,
			identityCommitment,
			relayerPrivateKey,
			preparedRegister,
		});
		return txHash;
	}

	// Consumer Phase 2: claim
	async prepareSettle(
		owner: Address,
		schemaId: Hex,
		tag: string,
		identity: Identity,
		stealthAddress: Address,
	): Promise<PrepareSettleResult> {
		return this.delegateeFangorn.consumer.prepareSettle({
			resourceId: SettlementRegistry.deriveResourceId(owner, schemaId, tag),
			identity,
			stealthAddress,
		});
	}

	async settle(
		owner: Address,
		schemaId: Hex,
		tag: string,
		relayerPrivateKey: Hex,
		preparedSettle: PrepareSettleResult,
	): Promise<{ txHash: Hex; nullifier: bigint }> {
		const { txHash, nullifier } = await this.delegateeFangorn.consumer.claim({
			owner,
			schemaId,
			tag,
			relayerPrivateKey,
			preparedSettle,
		});
		return { txHash, nullifier };
	}

	async tryDecrypt(
		owner: Address,
		nullifierHash: bigint,
		stealthSecretKey: Hex,
		schemaId: Hex,
		tag: string,
		field: string,
		rpcUrl: string,
		identity?: Identity,
		requireSettlement = true,
	): Promise<Uint8Array> {
		const walletClient = createWalletClient({
			account: privateKeyToAccount(stealthSecretKey),
			chain: arbitrumSepolia,
			transport: http(rpcUrl),
		});

		return this.delegateeFangorn.consumer.decrypt({
			owner,
			walletClient,
			schemaId,
			nullifierHash,
			tag,
			field,
			identity,
			skipSettlementCheck: !requireSettlement,
		});
	}

	// async tryDecryptDelegator(
	// 	owner: Address,
	// 	nullifierHash: BigInt,
	// 	schemaId: Hex,
	// 	tag: string,
	// 	field: string,
	// ): Promise<Uint8Array> {
	// 	return this.delegatorFangorn.consumer.decrypt({
	// 		owner,
	// 		schemaId,
	// 		nullifierHash,
	// 		tag,
	// 		field,
	// 		skipSettlementCheck: true,
	// 	});
	// }

	// ── Assertions ────────────────────────────────────────────────────────────

	async checkManifestExists(who: Address, schemaId: Hex): Promise<boolean> {
		const manifest = await this.delegatorFangorn.consumer.getManifest(who, schemaId);
		return manifest !== undefined;
	}

	async checkEntryExists(who: Address, schemaId: Hex, tag: string): Promise<boolean> {
		try {
			await this.delegatorFangorn.consumer.getEntry(who, schemaId, tag);
			return true;
		} catch {
			return false;
		}
	}

	// ── Accessors ─────────────────────────────────────────────────────────────

	getDelegatorAddress(): Address { return this.delegatorAddress; }
	getDelegatorFangorn(): Fangorn { return this.delegatorFangorn; }
	getDelegateeFangorn(): Fangorn { return this.delegateeFangorn; }
	getSettlementRegistry(): SettlementRegistry {
		return this.delegatorFangorn.getSettlementRegistry();
	}
}