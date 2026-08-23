import type { Abi, Address, Hash, PublicClient, WalletClient } from "viem";

/**
 * The one write path every contract client shares.
 *
 * Each client used to carry its own copy of this, which meant four places to fix
 * whenever the gas or fee policy moved. The type-safe per-function argument
 * checking still happens at the call site, in each client's thin `executeWrite`
 * wrapper — only the body lives here.
 *
 * Two deliberate choices, both about transactions that would otherwise silently
 * fail on a live L2:
 *
 * - **30% gas headroom.** The estimate is taken against the current state; by the
 *   time the transaction lands the state has moved. Unused gas is refunded, so
 *   the headroom is free and running out of it is not.
 * - **3x maxFeePerGas.** This is a ceiling, not a payment — you pay
 *   base + priority. Quoting it tightly is how a transaction gets stuck when the
 *   base fee ticks up between estimate and inclusion.
 */
export async function sendWrite(
	publicClient: PublicClient,
	walletClient: WalletClient,
	address: Address,
	abi: Abi,
	functionName: string,
	args: readonly unknown[],
	value?: bigint,
): Promise<Hash> {
	if (!walletClient.chain) throw new Error("Chain required");
	if (!walletClient.account) throw new Error("Account required");
	const { chain, account } = walletClient;

	const fees = await publicClient.estimateFeesPerGas();

	const gas = await publicClient.estimateContractGas({
		address,
		abi,
		functionName,
		args,
		account,
		value,
	} as unknown as Parameters<typeof publicClient.estimateContractGas>[0]);

	const hash = await walletClient.writeContract({
		address,
		abi,
		functionName,
		args,
		chain,
		account,
		gas: (gas * 130n) / 100n,
		maxFeePerGas: fees.maxFeePerGas * 3n,
		maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
		value,
	} as unknown as Parameters<typeof walletClient.writeContract>[0]);

	await publicClient.waitForTransactionReceipt({ hash });
	return hash;
}

/** Guard for clients that accept a read-only construction. */
export function requireWallet(
	walletClient: WalletClient | undefined,
	what: string,
): WalletClient {
	if (!walletClient) {
		throw new Error(`${what} requires a wallet client; this client is read-only`);
	}
	return walletClient;
}
