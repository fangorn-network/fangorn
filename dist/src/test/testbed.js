import { keccak256, parseUnits, toHex } from "viem";
import { Fangorn } from "../fangorn.js";
import { createLitClient } from "@lit-protocol/lit-client";
import { nagaDev } from "@lit-protocol/networks";
export class TestBed {
	delegatorFangorn;
	delegateeFangorn;
	vaultIds;
	config;
	constructor(delegatorFangorn, delegateeFangorn, config) {
		this.delegatorFangorn = delegatorFangorn;
		this.delegateeFangorn = delegateeFangorn;
		this.vaultIds = new Map();
		this.config = config;
	}
	static async init(
		delegatorWalletClient,
		delegateeWalletClient,
		jwt,
		gateway,
		litActionCid,
		// circuitJsonCid: string,
		contentRegistryContractAddress,
		usdcContractAddress,
		rpcUrl,
	) {
		// if (!circuitJsonCid) {
		// 	circuitJsonCid = "QmXw1rWUC2Kw52Qi55sfW3bCR7jheCDfSUgVRwvsP8ZZPE";
		// }
		const config = {
			litActionCid: litActionCid,
			// circuitJsonCid: circuitJsonCid,
			contentRegistryContractAddress: contentRegistryContractAddress,
			usdcContractAddress,
			chainName: "baseSepolia",
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
		const domain = "localhost:3000";
		const fangorn = await Fangorn.init(
			jwt,
			gateway,
			delegatorWalletClient,
			litClient,
			domain,
			config,
		);
		const delegateeFangorn = await Fangorn.init(
			jwt,
			gateway,
			delegateeWalletClient,
			delegateeLitClient,
			domain,
			config,
		);
		return new TestBed(fangorn, delegateeFangorn, config);
	}
	async setupVault(name) {
		if (!this.vaultIds.get(name)) {
			const vaultId = await this.delegatorFangorn.createVault(name);
			this.vaultIds.set(name, vaultId);
		}
		return this.vaultIds.get(name);
	}
	async fileUpload(vaultId, filedata) {
		await this.delegatorFangorn.upload(vaultId, filedata);
	}
	async tryDecrypt(vaultId, tag) {
		return await this.delegateeFangorn.decryptFile(vaultId, tag);
	}
	async buildUsdcAuthorization(recipient, amount, chainId, usdcAddress) {
		const walletClient = this.delegateeFangorn["walletClient"];
		const account = walletClient.account;
		const domain = {
			name: "USDC",
			version: "2",
			chainId: chainId,
			verifyingContract: usdcAddress,
		};
		const types = {
			TransferWithAuthorization: [
				{ name: "from", type: "address" },
				{ name: "to", type: "address" },
				{ name: "value", type: "uint256" },
				{ name: "validAfter", type: "uint256" },
				{ name: "validBefore", type: "uint256" },
				{ name: "nonce", type: "bytes32" },
			],
		};
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
	async payForFile(vaultId, tag, amount, to) {
		const auth = await this.buildUsdcAuthorization(
			to,
			amount,
			84532,
			this.config.usdcContractAddress,
		);
		// delegatee = its own facilitator
		await this.delegateeFangorn.pay(vaultId, tag, auth.to, auth);
	}
}
