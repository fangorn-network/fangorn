import { Account, Address, Hex } from "viem";
import { createRequire } from "module";
import { Fangorn } from "../fangorn.js";

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
	) {
		const fangorn = await Fangorn.init(
			delegatorAccount,
			rpcUrl,
			zkGateAddress as Address,
			jwt,
			gateway,
		);

		const delegateeFangorn = await Fangorn.init(
			delegateeAcount,
			rpcUrl,
			zkGateAddress as Address,
			jwt,
			gateway,
		);

		return new TestBed(fangorn, delegateeFangorn);
	}

	async setupVault(password: string) {
		if (!this.vaultIds.get(password)) {
			const vaultId = await this.delegatorFangorn.createVault(password);
			this.vaultIds.set(password, vaultId);
		}

		return this.vaultIds.get(password)!;
	}

	async fileUpload(
		vaultId: Hex,
		filedata: { tag: string; data: string }[],
		ipfsCid: string,
	) {
		for (let entry of filedata) {
			await this.delegatorFangorn.addFile(
				vaultId,
				entry.tag,
				entry.data,
				ipfsCid,
			);
		}

		await this.delegatorFangorn.commitVault(vaultId);
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
