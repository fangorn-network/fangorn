import {
	encodeFunctionData,
	toHex,
	type Abi,
	type Address,
	type Hash,
	type Hex,
	type PublicClient,
	type WalletClient,
} from "viem";

/**
 * An unsigned transaction, hex-encoded and ready to hand to a browser wallet's
 * `eth_sendTransaction` — no `from`, since the signing wallet supplies it.
 */
export interface PreparedTx {
	to: Address;
	data: Hex;
	chainId: number | undefined;
	gas: Hex;
	maxFeePerGas: Hex;
	maxPriorityFeePerGas: Hex;
}

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

/**
 * Build a call as an UNSIGNED transaction for `from` to sign in their own wallet,
 * instead of sending it from a client's wallet.
 *
 * Fees and gas are quoted here rather than left to the wallet. Wallet estimation
 * runs too tight against a live L2 base fee, and an eth_estimateGas from the
 * wallet against a public RPC is what surfaces as "Network fee Unavailable" in
 * MetaMask. maxFeePerGas is only a ceiling — you pay base+priority — so headroom
 * costs nothing.
 *
 * Simulating also turns a would-be revert into a clear error now, naming the
 * contract's reason, instead of a cryptic wallet message after the user has
 * already clicked sign. `simulate: false` skips it for a call that can only
 * succeed after an earlier one in the same batch lands (a join after its
 * approval); `fallbackGas` is then the gas, as it is when the RPC fails.
 */
export async function prepareWrite(
	publicClient: PublicClient,
	from: Address,
	address: Address,
	abi: Abi,
	functionName: string,
	args: readonly unknown[],
	opts: { fallbackGas: bigint; simulate?: boolean },
): Promise<PreparedTx> {
	const data = encodeFunctionData({ abi, functionName, args } as unknown as Parameters<
		typeof encodeFunctionData
	>[0]);
	const fees = await publicClient.estimateFeesPerGas();

	let gas = opts.fallbackGas;
	if (opts.simulate ?? true) {
		try {
			const estimate = await publicClient.estimateContractGas({
				address,
				abi,
				functionName,
				args,
				account: from,
			} as unknown as Parameters<typeof publicClient.estimateContractGas>[0]);
			gas = (estimate * 3n) / 2n;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (/revert/i.test(message)) {
				throw new Error(`${functionName} would revert: ${message}`);
			}
			// An RPC hiccup, not a revert: proceed with the ceiling.
		}
	}

	return {
		to: address,
		data,
		chainId: publicClient.chain?.id,
		gas: toHex(gas),
		maxFeePerGas: toHex(fees.maxFeePerGas * 2n),
		maxPriorityFeePerGas: toHex(fees.maxPriorityFeePerGas),
	};
}
