import { Account, createWalletClient, Hex, http, WalletClient } from "viem";
import { AppConfig, Fangorn } from "../fangorn.js";
import { Filedata } from "../types/types.js";
import { baseSepolia } from "viem/chains";

export class TestBed {
	private delegatorFangorn: Fangorn;
	private delegateeFangorn: Fangorn;

	private vaultIds: Map<string, Hex>;

	constructor(delegatorFangorn: Fangorn, delegateeFangorn: Fangorn) {
		this.delegatorFangorn = delegatorFangorn;
		this.delegateeFangorn = delegateeFangorn;
		this.vaultIds = new Map();
	}

	public static async init(
		delegatorWalletClient: WalletClient,
		delegateeWalletClient: WalletClient,
		jwt: string,
		gateway: string,
		litActionCid: string,
		circuitJsonCid: string,
		zkGateContractAddress: Hex,
		rpcUrl: string,
	) {
		if (!circuitJsonCid) {
			circuitJsonCid = "QmXw1rWUC2Kw52Qi55sfW3bCR7jheCDfSUgVRwvsP8ZZPE";
		}
		const config: AppConfig = {
			litActionCid: litActionCid,
			circuitJsonCid: circuitJsonCid,
			zkGateContractAddress: zkGateContractAddress,
			chainName: "baseSepolia",
			domain: "localhost:3000",
			rpcUrl: rpcUrl,
		};

		const fangorn = await Fangorn.init(
			jwt,
			gateway,
			delegatorWalletClient,
			config,
		);
		const delegateeFangorn = await Fangorn.init(
			jwt,
			gateway,
			delegateeWalletClient,
			config,
		);

		return new TestBed(fangorn, delegateeFangorn);
	}

	async setupVault(name: string, password: string) {
		if (!this.vaultIds.get(password)) {
			const vaultId = await this.delegatorFangorn.createVault(name, password);
			this.vaultIds.set(password, vaultId);
		}

		return this.vaultIds.get(password)!;
	}

	async fileUpload(vaultId: Hex, filedata: Filedata[]) {
		await this.delegatorFangorn.upload(vaultId, filedata);
	}

	async tryDecrypt(vaultId: Hex, tag: string, password: string) {
		return await this.delegateeFangorn.decryptFile(vaultId, tag, password);
	}
}
