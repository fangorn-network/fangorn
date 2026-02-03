import { Address, Hex, WalletClient } from "viem";
import { AppConfig, Fangorn } from "../fangorn.js";
import { Filedata } from "../types/types.js";
export declare class TestBed {
	private delegatorFangorn;
	private delegateeFangorn;
	private vaultIds;
	private config;
	constructor(
		delegatorFangorn: Fangorn,
		delegateeFangorn: Fangorn,
		config: AppConfig,
	);
	static init(
		delegatorWalletClient: WalletClient,
		delegateeWalletClient: WalletClient,
		jwt: string,
		gateway: string,
		litActionCid: string,
		contentRegistryContractAddress: Hex,
		usdcContractAddress: Hex,
		rpcUrl: string,
	): Promise<TestBed>;
	setupVault(name: string): Promise<`0x${string}`>;
	fileUpload(vaultId: Hex, filedata: Filedata[]): Promise<void>;
	tryDecrypt(vaultId: Hex, tag: string): Promise<Uint8Array<ArrayBufferLike>>;
	buildUsdcAuthorization(
		recipient: Address,
		amount: string,
		chainId: number,
		usdcAddress: Address,
	): Promise<{
		from: `0x${string}`;
		to: `0x${string}`;
		amount: bigint;
		validAfter: bigint;
		validBefore: bigint;
		nonce: `0x${string}`;
		signature: `0x${string}`;
	}>;
	payForFile(
		vaultId: Hex,
		tag: string,
		amount: string,
		to: Address,
	): Promise<void>;
}
