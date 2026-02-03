import { parseEventLogs } from "viem";
export const CONTENTREGISTRY_ABI = [
	// Vault creation
	{
		name: "createVault",
		type: "function",
		stateMutability: "payable",
		inputs: [{ name: "name", type: "string" }],
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
	{
		name: "pay",
		type: "function",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "commitment", type: "bytes32" },
			{ name: "from", type: "address" },
			{ name: "to", type: "address" },
			{ name: "value", type: "uint256" },
			{ name: "validAfter", type: "uint256" },
			{ name: "validBefore", type: "uint256" },
			{ name: "nonce", type: "bytes32" },
			{ name: "v", type: "uint8" },
			{ name: "r", type: "bytes32" },
			{ name: "s", type: "bytes32" },
		],
		outputs: [],
	},
	// Read functions
	{
		name: "getVault",
		type: "function",
		stateMutability: "view",
		inputs: [{ name: "vaultId", type: "bytes32" }],
		outputs: [
			{ name: "poseidonRoot", type: "bytes32" },
			{ name: "manifestCid", type: "string" },
			{ name: "owner", type: "address" },
			{ name: "name", type: "string" },
		],
	},
	{
		name: "vaults",
		type: "function",
		stateMutability: "view",
		inputs: [
			{ name: "commitment", type: "bytes32" },
			{ name: "user", type: "address" },
		],
		outputs: [
			{ name: "passwordHash", type: "bytes32" },
			{ name: "poseidonRoot", type: "bytes32" },
			{ name: "manifestCid", type: "string" },
			{ name: "owner", type: "address" },
		],
	},
	{
		name: "checkSettlement",
		type: "function",
		stateMutability: "view",
		inputs: [
			{ name: "commitment", type: "bytes32" },
			{ name: "user", type: "address" },
		],
		outputs: [{ name: "hasAccess", type: "bool" }],
	},
	{
		name: "getOwnedVault",
		type: "function",
		stateMutability: "view",
		inputs: [{ name: "owner", type: "address" }],
		outputs: [{ type: "bytes32[]" }],
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
];
export class ContentRegistry {
	publicClient;
	walletClient;
	contractAddress;
	constructor(contractAddress, publicClient, walletClient) {
		this.publicClient = publicClient;
		this.contractAddress = contractAddress;
		this.walletClient = walletClient;
	}
	getWriteConfig() {
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
	// async getVaultCreationFee(): Promise<bigint> {
	// 	return this.publicClient.readContract({
	// 		address: this.contractAddress,
	// 		abi: CONTENTREGISTRY_ABI,
	// 		functionName: "vaultCreationFee",
	// 	});
	// }
	async checkSettlement(commitment, user) {
		const result = await this.publicClient.readContract({
			address: this.contractAddress,
			abi: CONTENTREGISTRY_ABI,
			functionName: "checkSettlement",
			args: [commitment, user],
		});
		return result;
	}
	async getVault(vaultId) {
		const result = await this.publicClient.readContract({
			address: this.contractAddress,
			abi: CONTENTREGISTRY_ABI,
			functionName: "getVault",
			args: [vaultId],
		});
		return result;
	}
	async vaultExists(vaultId) {
		const vault = await this.getVault(vaultId);
		return vault.owner !== "0x0000000000000000000000000000000000000000";
	}
	async getOwnedVaults(address) {
		const result = await this.publicClient.readContract({
			address: this.contractAddress,
			abi: CONTENTREGISTRY_ABI,
			functionName: "getOwnedVault",
			args: [address],
		});
		return result;
	}
	// --- Write Functions ---
	async createVault(name) {
		const { chain, account } = this.getWriteConfig();
		const hash = await this.walletClient.writeContract({
			address: this.contractAddress,
			abi: CONTENTREGISTRY_ABI,
			functionName: "createVault",
			args: [name],
			chain,
			account,
		});
		const receipt = await this.waitForTransaction(hash);
		const logs = parseEventLogs({
			abi: CONTENTREGISTRY_ABI,
			logs: receipt.logs,
		});
		let vaultId = "0x";
		for (const log of logs) {
			if (log.eventName == "VaultCreated") {
				// TODO: verify the owner too
				vaultId = log.args.vaultId;
			}
		}
		return { hash, vaultId };
	}
	async updateVault(vaultId, newRoot, newManifestCid) {
		const { chain, account } = this.getWriteConfig();
		return this.walletClient.writeContract({
			address: this.contractAddress,
			abi: CONTENTREGISTRY_ABI,
			functionName: "updateVault",
			args: [vaultId, newRoot, newManifestCid],
			chain,
			account,
		});
	}
	/**
	 * Settles the payment on-chain using the EIP-3009 authorization
	 * This is usually called by the Facilitator.
	 */
	async pay(args) {
		const { chain, account } = this.getWriteConfig();
		return this.walletClient.writeContract({
			address: this.contractAddress,
			abi: CONTENTREGISTRY_ABI,
			functionName: "pay",
			args: [
				args.commitment,
				args.from,
				args.to,
				args.value,
				args.validAfter,
				args.validBefore,
				args.nonce,
				args.v,
				args.r,
				args.s,
			],
			chain,
			account,
		});
	}
	// --- Helpers ---
	async waitForTransaction(hash) {
		return this.publicClient.waitForTransactionReceipt({ hash });
	}
}
