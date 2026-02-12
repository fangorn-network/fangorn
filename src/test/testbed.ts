import { Address, Hex, keccak256, parseUnits, toHex, WalletClient } from "viem";
import { Fangorn } from "../fangorn.js";
import { Filedata } from "../types/index.js";
import { createLitClient } from "@lit-protocol/lit-client";
import { nagaDev } from "@lit-protocol/networks";
import { PinataSDK } from "pinata";
import { PinataStorage } from "../providers/storage/pinata/index.js";
import { AppConfig } from "../config.js";

export class TestBed {
	private delegatorFangorn: Fangorn;
	private delegateeFangorn: Fangorn;

	private vaultIds: Map<string, Hex>;

	private config: AppConfig;

	constructor(
		delegatorFangorn: Fangorn,
		delegateeFangorn: Fangorn,
		config: AppConfig,
	) {
		this.delegatorFangorn = delegatorFangorn;
		this.delegateeFangorn = delegateeFangorn;
		this.vaultIds = new Map();
		this.config = config;
	}

	public static async init(
		delegatorWalletClient: WalletClient,
		delegateeWalletClient: WalletClient,
		jwt: string,
		gateway: string,
		litActionCid: string,
		// circuitJsonCid: string,
		contentRegistryContractAddress: Hex,
		usdcContractAddress: Hex,
		rpcUrl: string,
		chain: string,
	) {
		// if (!circuitJsonCid) {
		// 	circuitJsonCid = "QmXw1rWUC2Kw52Qi55sfW3bCR7jheCDfSUgVRwvsP8ZZPE";
		// }

		const config: AppConfig = {
			litActionCid: litActionCid,
			// circuitJsonCid: circuitJsonCid,
			contentRegistryContractAddress: contentRegistryContractAddress,
			usdcContractAddress,
			chainName: chain,
			rpcUrl: rpcUrl,
		};

		// client to interact with LIT proto
		const litClient = await createLitClient({
			network: nagaDev,
		});

		// client to interact with LIT proto
		const delegateeLitClient = await createLitClient({
			network: nagaDev,
		});

		// storage via Pinata
		const pinata = new PinataSDK({
			pinataJwt: jwt,
			pinataGateway: gateway,
		});

		const delegatorStorage = new PinataStorage(pinata);

		const delegateeStorage = new PinataStorage(pinata);

		const domain = "localhost";

		const fangorn = await Fangorn.init(
			delegatorWalletClient,
			delegatorStorage,
			litClient,
			domain,
			config,
		);

		const delegateeFangorn = await Fangorn.init(
			delegateeWalletClient,
			delegateeStorage,
			delegateeLitClient,
			domain,
			config,
		);

		return new TestBed(fangorn, delegateeFangorn, config);
	}

	async setupVault(name: string) {
		if (!this.vaultIds.get(name)) {
			const vaultId = await this.delegatorFangorn.registerDataSource(name);
			this.vaultIds.set(name, vaultId);
		}

		return this.vaultIds.get(name)!;
	}

	async fileUpload(vaultId: Hex, filedata: Filedata[]) {
		await this.delegatorFangorn.upload(vaultId, filedata);
	}

	async tryDecrypt(vaultId: Hex, tag: string) {
		return await this.delegateeFangorn.decryptFile(vaultId, tag);
	}

	async buildUsdcAuthorization(
		recipient: Address,
		amount: string,
		chainId: number,
		usdcAddress: Address,
	) {
		const walletClient = this.delegateeFangorn["walletClient"];
		const account = walletClient.account!;

		const domain = {
			// note: for arbitrum sepolia
			name: "USD Coin",
			version: "2",
			chainId: chainId,
			verifyingContract: usdcAddress,
		} as const;

		const types = {
			TransferWithAuthorization: [
				{ name: "from", type: "address" },
				{ name: "to", type: "address" },
				{ name: "value", type: "uint256" },
				{ name: "validAfter", type: "uint256" },
				{ name: "validBefore", type: "uint256" },
				{ name: "nonce", type: "bytes32" },
			],
		} as const;

		const value = parseUnits(amount, 6);

		// random nonce
		const nonce = keccak256(toHex(crypto.getRandomValues(new Uint8Array(32))));

		const signature = await walletClient.signTypedData({
			account,
			domain,
			types,
			primaryType: "TransferWithAuthorization",
			message: {
				from: account.address,
				to: recipient,
				value,
				validAfter: 0n,
				// A very large number (effectively never expires)
				validBefore: 281474976710655n,
				nonce,
			},
		});

		return {
			from: account.address,
			to: recipient,
			amount: value,
			validAfter: 0n,
			validBefore: 281474976710655n,
			nonce,
			signature,
		};
	}

	public async payForFile(
		vaultId: Hex,
		tag: string,
		amount: string,
		to: Address,
	) {
		const auth = await this.buildUsdcAuthorization(
			to,
			amount,
			421614, // TODO
			this.config.usdcContractAddress,
		);

		// delegatee = its own facilitator
		await this.delegateeFangorn.pay(vaultId, tag, auth.to, auth);
	}
}
