import {
	type PublicClient,
	type WalletClient,
	type Address,
	type Hash,
	Hex,
} from "viem";
export interface Vault {
	poseidonRoot: `0x${string}`;
	manifestCid: string;
	owner: Address;
	name: string;
}
export declare const CONTENTREGISTRY_ABI: readonly [
	{
		readonly name: "createVault";
		readonly type: "function";
		readonly stateMutability: "payable";
		readonly inputs: readonly [
			{
				readonly name: "name";
				readonly type: "string";
			},
		];
		readonly outputs: readonly [
			{
				readonly name: "vaultId";
				readonly type: "bytes32";
			},
		];
	},
	{
		readonly name: "updateVault";
		readonly type: "function";
		readonly stateMutability: "nonpayable";
		readonly inputs: readonly [
			{
				readonly name: "vaultId";
				readonly type: "bytes32";
			},
			{
				readonly name: "newRoot";
				readonly type: "bytes32";
			},
			{
				readonly name: "newManifestCid";
				readonly type: "string";
			},
		];
		readonly outputs: readonly [];
	},
	{
		readonly name: "pay";
		readonly type: "function";
		readonly stateMutability: "nonpayable";
		readonly inputs: readonly [
			{
				readonly name: "commitment";
				readonly type: "bytes32";
			},
			{
				readonly name: "from";
				readonly type: "address";
			},
			{
				readonly name: "to";
				readonly type: "address";
			},
			{
				readonly name: "value";
				readonly type: "uint256";
			},
			{
				readonly name: "validAfter";
				readonly type: "uint256";
			},
			{
				readonly name: "validBefore";
				readonly type: "uint256";
			},
			{
				readonly name: "nonce";
				readonly type: "bytes32";
			},
			{
				readonly name: "v";
				readonly type: "uint8";
			},
			{
				readonly name: "r";
				readonly type: "bytes32";
			},
			{
				readonly name: "s";
				readonly type: "bytes32";
			},
		];
		readonly outputs: readonly [];
	},
	{
		readonly name: "getVault";
		readonly type: "function";
		readonly stateMutability: "view";
		readonly inputs: readonly [
			{
				readonly name: "vaultId";
				readonly type: "bytes32";
			},
		];
		readonly outputs: readonly [
			{
				readonly name: "poseidonRoot";
				readonly type: "bytes32";
			},
			{
				readonly name: "manifestCid";
				readonly type: "string";
			},
			{
				readonly name: "owner";
				readonly type: "address";
			},
			{
				readonly name: "name";
				readonly type: "string";
			},
		];
	},
	{
		readonly name: "vaults";
		readonly type: "function";
		readonly stateMutability: "view";
		readonly inputs: readonly [
			{
				readonly name: "commitment";
				readonly type: "bytes32";
			},
			{
				readonly name: "user";
				readonly type: "address";
			},
		];
		readonly outputs: readonly [
			{
				readonly name: "passwordHash";
				readonly type: "bytes32";
			},
			{
				readonly name: "poseidonRoot";
				readonly type: "bytes32";
			},
			{
				readonly name: "manifestCid";
				readonly type: "string";
			},
			{
				readonly name: "owner";
				readonly type: "address";
			},
		];
	},
	{
		readonly name: "checkSettlement";
		readonly type: "function";
		readonly stateMutability: "view";
		readonly inputs: readonly [
			{
				readonly name: "commitment";
				readonly type: "bytes32";
			},
			{
				readonly name: "user";
				readonly type: "address";
			},
		];
		readonly outputs: readonly [
			{
				readonly name: "hasAccess";
				readonly type: "bool";
			},
		];
	},
	{
		readonly name: "getOwnedVault";
		readonly type: "function";
		readonly stateMutability: "view";
		readonly inputs: readonly [
			{
				readonly name: "owner";
				readonly type: "address";
			},
		];
		readonly outputs: readonly [
			{
				readonly type: "bytes32[]";
			},
		];
	},
	{
		readonly name: "VaultCreated";
		readonly type: "event";
		readonly inputs: readonly [
			{
				readonly name: "vaultId";
				readonly type: "bytes32";
				readonly indexed: true;
			},
			{
				readonly name: "owner";
				readonly type: "address";
				readonly indexed: true;
			},
		];
	},
	{
		readonly name: "VaultUpdated";
		readonly type: "event";
		readonly inputs: readonly [
			{
				readonly name: "vaultId";
				readonly type: "bytes32";
				readonly indexed: true;
			},
			{
				readonly name: "newRoot";
				readonly type: "bytes32";
				readonly indexed: false;
			},
			{
				readonly name: "newManifestCid";
				readonly type: "string";
				readonly indexed: false;
			},
		];
	},
];
export declare class ContentRegistry {
	private publicClient;
	private walletClient;
	private contractAddress;
	constructor(
		contractAddress: Address,
		publicClient: PublicClient,
		walletClient: WalletClient,
	);
	private getWriteConfig;
	getContractAddress(): `0x${string}`;
	checkSettlement(commitment: Hex, user: Address): Promise<boolean>;
	getVault(vaultId: `0x${string}`): Promise<Vault>;
	vaultExists(vaultId: `0x${string}`): Promise<boolean>;
	getOwnedVaults(address: Address): Promise<Hex[]>;
	createVault(name: string): Promise<{
		hash: Hash;
		vaultId: `0x${string}`;
	}>;
	updateVault(
		vaultId: `0x${string}`,
		newRoot: `0x${string}`,
		newManifestCid: string,
	): Promise<Hash>;
	/**
	 * Settles the payment on-chain using the EIP-3009 authorization
	 * This is usually called by the Facilitator.
	 */
	pay(args: {
		commitment: Hex;
		from: Address;
		to: Address;
		value: bigint;
		validAfter: bigint;
		validBefore: bigint;
		nonce: Hex;
		v: number;
		r: Hex;
		s: Hex;
	}): Promise<Hash>;
	waitForTransaction(hash: Hash): Promise<import("viem").TransactionReceipt>;
}
