import { Account, Address, Hex } from "viem";
import { createRequire } from "module";
import { Fangorn } from "../fangorn.js";
import { Filedata } from "../types/types.js";

const require = createRequire(import.meta.url);
const circuit = require("../../circuits/preimage/target/preimage.json");

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
		zkGateAddress: string,
		rpcUrl: string,
		jwt: string,
		gateway: string,
		ipfsCid: string,
	) {
		const fangorn = await Fangorn.init(
			delegatorAccount,
			rpcUrl,
			zkGateAddress as Address,
			jwt,
			gateway,
			ipfsCid,
		);

		const delegateeFangorn = await Fangorn.init(
			delegateeAcount,
			rpcUrl,
			zkGateAddress as Address,
			jwt,
			gateway,
			ipfsCid,
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
		return await this.delegateeFangorn.decryptFile(
			vaultId,
			tag,
			password,
			circuit,
		);
	}
}
