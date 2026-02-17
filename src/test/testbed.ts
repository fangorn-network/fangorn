// e2e/testbed.ts

import {
	Address,
	Chain,
	Hex,
	keccak256,
	parseUnits,
	toHex,
	WalletClient,
	PublicClient,
	createPublicClient,
	http,
} from "viem";
import { Fangorn } from "../fangorn.js";
import { Filedata } from "../types/index.js";
import { createLitClient } from "@lit-protocol/lit-client";
import { nagaDev } from "@lit-protocol/networks";
import { PinataSDK } from "pinata";
import { PinataStorage } from "../providers/storage/pinata/index.js";
import { AppConfig } from "../config.js";
import { arbitrumSepolia, baseSepolia } from "viem/chains";
import { LitEncryptionService } from "../modules/encryption/lit.js";
import { Predicate } from "../modules/predicates/types.js";
import { SettlementTracker } from "../interface/settlement-tracker/settlementTracker.js";
import { computeTagCommitment, fieldToHex } from "../utils/index.js";
import { AccPredicate, emptyWallet } from "./test-predicate.js";
import { EvmChain } from "@lit-protocol/access-control-conditions";

export class TestBed {
	private delegatorFangorn: Fangorn;
	private delegateeFangorn: Fangorn;

	private vaultIds: Map<string, Hex>;
	private config: AppConfig;

	private litChain: EvmChain;

	constructor(
		delegatorFangorn: Fangorn,
		delegateeFangorn: Fangorn,
		storage: PinataStorage,
		config: AppConfig,
		litChain: EvmChain,
	) {
		this.delegatorFangorn = delegatorFangorn;
		this.delegateeFangorn = delegateeFangorn;
		this.vaultIds = new Map();
		this.config = config;
		this.litChain = litChain;
	}

	public static async init(
		delegatorWalletClient: WalletClient,
		delegateeWalletClient: WalletClient,
		jwt: string,
		gateway: string,
		dataSourceRegistryContractAddress: Hex,
		usdcContractAddress: Hex,
		rpcUrl: string,
		chain: string,
		litChain: EvmChain,
		caip2: number,
	) {
		let chainImpl: Chain = arbitrumSepolia;
		if (chain === "baseSepolia") {
			chainImpl = baseSepolia;
		}

		const config: AppConfig = {
			dataSourceRegistryContractAddress,
			usdcContractAddress,
			chainName: chain,
			chain: chainImpl,
			rpcUrl,
			caip2,
		};

		// Lit clients
		const delegatorLitClient = await createLitClient({ network: nagaDev });
		const delegateeLitClient = await createLitClient({ network: nagaDev });

		// Encryption services
		const delegatorEncryption = new LitEncryptionService(delegatorLitClient, {
			chainName: chain,
		});
		const delegateeEncryption = new LitEncryptionService(delegateeLitClient, {
			chainName: chain,
		});

		// Storage
		const pinata = new PinataSDK({
			pinataJwt: jwt,
			pinataGateway: gateway,
		});
		const delegatorStorage = new PinataStorage(pinata);
		const delegateeStorage = new PinataStorage(pinata);

		const domain = "localhost";

		// Fangorn instances
		const delegatorFangorn = await Fangorn.init(
			delegatorWalletClient,
			delegatorStorage,
			delegatorEncryption,
			domain,
			config,
		);

		const delegateeFangorn = await Fangorn.init(
			delegateeWalletClient,
			delegateeStorage,
			delegateeEncryption,
			domain,
			config,
		);

		return new TestBed(
			delegatorFangorn,
			delegateeFangorn,
			delegatorStorage,
			config,
			litChain,
		);
	}

	async registerDatasource(name: string): Promise<Hex> {
		const existing = this.vaultIds.get(name);
		if (existing) {
			return existing;
		}

		const id = await this.delegatorFangorn.registerDataSource(name);
		this.vaultIds.set(name, id);
		return id;
	}

	/**
	 * Upload files with payment predicates
	 */
	async fileUploadEmptyWallet(
		datasourceName: string,
		filedata: Filedata[],
	): Promise<string> {
		return await this.delegatorFangorn.upload(
			datasourceName,
			filedata,
			(_file) => emptyWallet(this.litChain),
		);
	}
	//   async (file) => {
	//     const commitment = await computeTagCommitment(vaultId, file.tag);
	//     return new PaymentPredicate(
	//       {
	//         commitment: fieldToHex(commitment),
	//         chainName: this.config.chainName,
	//         settlementTrackerContractAddress: this.config.settlementTrackerContractAddress,
	//       },
	//       this.storage,
	//     );
	//   },
	/**
	 * Upload files with a custom predicate factory
	 */
	async fileUploadWithPredicate(
		vaultId: Hex,
		filedata: Filedata[],
		predicateFactory: (file: Filedata) => Predicate | Promise<Predicate>,
	): Promise<string> {
		return await this.delegatorFangorn.upload(
			vaultId,
			filedata,
			predicateFactory,
		);
	}

	async tryDecrypt(
		owner: Address,
		name: string,
		tag: string,
	): Promise<Uint8Array> {
		return await this.delegateeFangorn.decryptFile(owner, name, tag);
	}

	async tryDecryptDelegator(
		owner: Address,
		name: string,
		tag: string,
	): Promise<Uint8Array> {
		return await this.delegatorFangorn.decryptFile(owner, name, tag);
	}

	async checkDatasourceRegistryExistence(
		who: Address,
		name: string,
	): Promise<boolean> {
		const datasource = await this.delegatorFangorn.getDataSource(who, name);
		return datasource.owner == who.toString() && datasource.name == name;
	}

	async checkDataExistence(who: Address, name: string, tag: string) {
		const entry = await this.delegatorFangorn.getDataSourceData(who, name, tag);
		console.log(entry);
	}

	// --- Payment helpers (will move to x402f) ---

	//   async buildUsdcAuthorization(
	//     recipient: Address,
	//     amount: string,
	//     chainId: number,
	//     usdcContractName: string,
	//     usdcAddress: Address,
	//   ) {
	//     const walletClient = this.delegateeFangorn["walletClient"];
	//     const account = walletClient.account!;
	//     const domain = {
	//       name: usdcContractName,
	//       version: "2",
	//       chainId: chainId,
	//       verifyingContract: usdcAddress,
	//     } as const;

	//     const types = {
	//       TransferWithAuthorization: [
	//         { name: "from", type: "address" },
	//         { name: "to", type: "address" },
	//         { name: "value", type: "uint256" },
	//         { name: "validAfter", type: "uint256" },
	//         { name: "validBefore", type: "uint256" },
	//         { name: "nonce", type: "bytes32" },
	//       ],
	//     } as const;

	//     const value = parseUnits(amount, 6);
	//     const nonce = keccak256(toHex(crypto.getRandomValues(new Uint8Array(32))));

	//     const signature = await walletClient.signTypedData({
	//       account,
	//       domain,
	//       types,
	//       primaryType: "TransferWithAuthorization",
	//       message: {
	//         from: account.address,
	//         to: recipient,
	//         value,
	//         validAfter: 0n,
	//         validBefore: 281474976710655n,
	//         nonce,
	//       },
	//     });

	//     return {
	//       from: account.address,
	//       to: recipient,
	//       amount: value,
	//       validAfter: 0n,
	//       validBefore: 281474976710655n,
	//       nonce,
	//       signature,
	//     };
	//   }

	//   public async payForFile(
	//     vaultId: Hex,
	//     tag: string,
	//     amount: string,
	//     to: Address,
	//   ) {
	//     const auth = await this.buildUsdcAuthorization(
	//       to,
	//       amount,
	//       this.config.caip2,
	//       this.config.usdcDomainName,
	//       this.config.usdcContractAddress,
	//     );

	//     const commitment = await computeTagCommitment(vaultId, tag);
	//     const commitmentHex = fieldToHex(commitment);

	//     // Use settlement tracker directly
	//     await this.settlementTracker.pay({
	//       commitment: commitmentHex,
	//       from: auth.from,
	//       to: auth.to,
	//       value: auth.amount,
	//       validAfter: auth.validAfter,
	//       validBefore: auth.validBefore,
	//       nonce: auth.nonce,
	//       ...this.parseSignature(auth.signature),
	//     });
	//   }

	private parseSignature(signature: Hex): { v: number; r: Hex; s: Hex } {
		// viem's parseSignature or manual extraction
		const r = `0x${signature.slice(2, 66)}` as Hex;
		const s = `0x${signature.slice(66, 130)}` as Hex;
		const v = parseInt(signature.slice(130, 132), 16);
		return { v, r, s };
	}
}
