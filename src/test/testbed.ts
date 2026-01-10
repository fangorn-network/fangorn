import { Account, Hex } from "viem";
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
		delegatorAccount: Account,
		delegateeAcount: Account,
		jwt: string,
		gateway: string,
		litActionCid: string,
		circuitJsonCid: string,
		zkGateContractAddress: Hex,
		rpcUrl: string,
	) {
		const config: AppConfig = {
			litActionCid: litActionCid,
			circuitJsonCid: circuitJsonCid,
			zkGateContractAddress: zkGateContractAddress,
			chain: baseSepolia,
			chainName: "baseSepolia",
			rpcUrl: rpcUrl,
		};

		const fangorn = await Fangorn.init(delegatorAccount, jwt, gateway, config);
		const delegateeFangorn = await Fangorn.init(
			delegateeAcount,
			jwt,
			gateway,
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
