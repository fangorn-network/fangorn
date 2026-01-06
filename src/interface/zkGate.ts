// src/interface/zkGate.ts
import {
	type PublicClient,
	type WalletClient,
	type Address,
	type Hash,
	type Hex,
	keccak256,
	encodeAbiParameters,
	parseAbiParameters,
} from "viem";

export interface Vault {
	passwordHash: `0x${string}`;
	poseidonRoot: `0x${string}`;
	manifestCid: string;
	owner: Address;
}

const ZKGATE_ABI = [
	// Vault creation
	{
		name: "createVault",
		type: "function",
		stateMutability: "payable",
		inputs: [{ name: "passwordHash", type: "bytes32" }],
		outputs: [{ name: "vaultId", type: "bytes32" }],
	},
	// Vault update
	{
		name: "updateVault",
		type: "function",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "vaultId", type: "bytes32" },
			{ name: "newRoot", type: "bytes32" },
			{ name: "newManifestCid", type: "string" },
		],
		outputs: [],
	},
	// Proof submission
	{
		name: "submitProof",
		type: "function",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "vaultId", type: "bytes32" },
			{ name: "cidCommitment", type: "bytes32" },
			{ name: "nullifier", type: "bytes32" },
			{ name: "proof", type: "bytes" },
		],
		outputs: [],
	},
	// Read functions
	{
		name: "checkCIDAccess",
		type: "function",
		stateMutability: "view",
		inputs: [
			{ name: "vaultId", type: "bytes32" },
			{ name: "cidCommitment", type: "bytes32" },
			{ name: "user", type: "address" },
		],
		outputs: [{ type: "bool" }],
	},
	{
		name: "getVault",
		type: "function",
		stateMutability: "view",
		inputs: [{ name: "vaultId", type: "bytes32" }],
		outputs: [
			{ name: "passwordHash", type: "bytes32" },
			{ name: "poseidonRoot", type: "bytes32" },
			{ name: "manifestCid", type: "string" },
			{ name: "owner", type: "address" },
		],
	},
	{
		name: "vaults",
		type: "function",
		stateMutability: "view",
		inputs: [{ name: "vaultId", type: "bytes32" }],
		outputs: [
			{ name: "passwordHash", type: "bytes32" },
			{ name: "poseidonRoot", type: "bytes32" },
			{ name: "manifestCid", type: "string" },
			{ name: "owner", type: "address" },
		],
	},
	{
		name: "spentNullifiers",
		type: "function",
		stateMutability: "view",
		inputs: [{ name: "nullifier", type: "bytes32" }],
		outputs: [{ type: "bool" }],
	},
	{
		name: "cidAccess",
		type: "function",
		stateMutability: "view",
		inputs: [
			{ name: "vaultId", type: "bytes32" },
			{ name: "cidCommitment", type: "bytes32" },
			{ name: "user", type: "address" },
		],
		outputs: [{ type: "bool" }],
	},
	{
		name: "vaultCreationFee",
		type: "function",
		stateMutability: "view",
		inputs: [],
		outputs: [{ type: "uint256" }],
	},
	// Events
	{
		name: "VaultCreated",
		type: "event",
		inputs: [
			{ name: "vaultId", type: "bytes32", indexed: true },
			{ name: "owner", type: "address", indexed: true },
		],
	},
	{
		name: "VaultUpdated",
		type: "event",
		inputs: [
			{ name: "vaultId", type: "bytes32", indexed: true },
			{ name: "newRoot", type: "bytes32", indexed: false },
			{ name: "newManifestCid", type: "string", indexed: false },
		],
	},
	{
		name: "CIDAccessGranted",
		type: "event",
		inputs: [
			{ name: "vaultId", type: "bytes32", indexed: true },
			{ name: "cidCommitment", type: "bytes32", indexed: true },
			{ name: "user", type: "address", indexed: true },
		],
	},
] as const;

export class ZKGate {
	private publicClient: PublicClient;
	private walletClient: WalletClient;
	private contractAddress: Address;

	constructor(
		contractAddress: Address,
		publicClient: PublicClient,
		walletClient: WalletClient,
	) {
		this.publicClient = publicClient;
		this.contractAddress = contractAddress;
		this.walletClient = walletClient;
	}

	private getWriteConfig() {
		if (!this.walletClient.chain) throw new Error("Chain required");
		if (!this.walletClient.account) throw new Error("Account required");
		return {
			chain: this.walletClient.chain,
			account: this.walletClient.account,
		};
	}

	getContractAddress() {
		return this.contractAddress;
	}

	// --- Read Functions ---

	async getVaultCreationFee(): Promise<bigint> {
		return this.publicClient.readContract({
			address: this.contractAddress,
			abi: ZKGATE_ABI,
			functionName: "vaultCreationFee",
		});
	}

	async getVault(vaultId: `0x${string}`): Promise<Vault> {
		const [passwordHash, poseidonRoot, manifestCid, owner] =
			await this.publicClient.readContract({
				address: this.contractAddress,
				abi: ZKGATE_ABI,
				functionName: "getVault",
				args: [vaultId],
			});
		return { passwordHash, poseidonRoot, manifestCid, owner };
	}

	async checkCIDAccess(
		vaultId: `0x${string}`,
		cidCommitment: `0x${string}`,
		user: Address,
	): Promise<boolean> {
		return this.publicClient.readContract({
			address: this.contractAddress,
			abi: ZKGATE_ABI,
			functionName: "checkCIDAccess",
			args: [vaultId, cidCommitment, user],
		});
	}

	async isNullifierSpent(nullifier: `0x${string}`): Promise<boolean> {
		return this.publicClient.readContract({
			address: this.contractAddress,
			abi: ZKGATE_ABI,
			functionName: "spentNullifiers",
			args: [nullifier],
		});
	}

	async vaultExists(vaultId: `0x${string}`): Promise<boolean> {
		const vault = await this.getVault(vaultId);
		return vault.owner !== "0x0000000000000000000000000000000000000000";
	}

	// --- Write Functions ---

	async createVault(
		passwordHash: `0x${string}`,
		fee: bigint,
	): Promise<{ hash: Hash; vaultId: `0x${string}` }> {
		const { chain, account } = this.getWriteConfig();

		const hash = await this.walletClient.writeContract({
			address: this.contractAddress,
			abi: ZKGATE_ABI,
			functionName: "createVault",
			args: [passwordHash],
			value: fee,
			chain,
			account,
		});

		const vaultId = keccak256(
			encodeAbiParameters(parseAbiParameters("bytes32, address"), [
				passwordHash,
				account.address,
			]),
		);

		return { hash, vaultId };
	}

	async updateVault(
		vaultId: `0x${string}`,
		newRoot: `0x${string}`,
		newManifestCid: string,
	): Promise<Hash> {
		const { chain, account } = this.getWriteConfig();

		return this.walletClient.writeContract({
			address: this.contractAddress,
			abi: ZKGATE_ABI,
			functionName: "updateVault",
			args: [vaultId, newRoot, newManifestCid],
			chain,
			account,
		});
	}

	async submitProof(
		vaultId: `0x${string}`,
		cidCommitment: `0x${string}`,
		nullifier: `0x${string}`,
		proof: `0x${string}`,
	): Promise<Hash> {
		const { chain, account } = this.getWriteConfig();

		return this.walletClient.writeContract({
			address: this.contractAddress,
			abi: ZKGATE_ABI,
			functionName: "submitProof",
			args: [vaultId, cidCommitment, nullifier, proof],
			chain,
			account,
		});
	}

	// --- Helpers ---

	async waitForTransaction(hash: Hash) {
		return this.publicClient.waitForTransactionReceipt({ hash });
	}

	deriveVaultId(passwordHash: `0x${string}`, owner: Address): `0x${string}` {
		return keccak256(
			encodeAbiParameters(parseAbiParameters("bytes32, address"), [
				passwordHash,
				owner,
			]),
		);
	}
}
