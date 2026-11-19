import {
	encodeFunctionData,
	toHex,
	WaitForTransactionReceiptTimeoutError,
	zeroAddress,
	type Abi,
	type Address,
	type Hash,
	type Hex,
	type PublicClient,
	type TransactionReceipt,
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
 * - **30% + APPEND_ALLOWANCE gas headroom.** The estimate is taken against the
 *   current state; by the time the transaction lands the state has moved. The
 *   fixed allowance covers the one jump the 30% can't: other updates landing
 *   first, so this one appends to the log at a length of 2^k − 1. Unused gas is
 *   refunded, so the headroom is free and running out of it is not.
 * - **3x maxFeePerGas.** This is a ceiling, not a payment — you pay
 *   base + priority. Quoting it tightly is how a transaction gets stuck when the
 *   base fee ticks up between estimate and inclusion.
 */
/**
 * The most DataRegistry._append can cost over an append estimated at any other
 * log length: 63 merges (cold SLOAD + keccak, ~2.5k each) and a first write to
 * peaks[63] (~20k). logLength is a uint64, so this is a hard bound, not a guess.
 * The contracts repo pins it: test_append_worst_case_fits_sdk_allowance.
 */
export const APPEND_ALLOWANCE = 200_000n;

/**
 * writeContract reads the nonce as the node's pending count. Two sends from one key
 * that overlap both read it before either reaches the pool, take the same nonce, and
 * the second is rejected as "replacement transaction underpriced". So sends from one
 * account go one at a time, each only until the node has it (not until it is mined):
 * the next then reads a count that includes it. A failed send leaves no gap, unlike
 * viem's nonceManager, which never gives back a nonce it handed out.
 */
// ponytail: per-process; two processes on one key still race (confirmTx says so loudly).
const sending = new Map<string, Promise<unknown>>();
function oneAtATime<T>(key: string, f: () => Promise<T>): Promise<T> {
	const run = (sending.get(key) ?? Promise.resolve()).then(f, f);
	sending.set(
		key,
		run.catch(() => undefined),
	);
	return run;
}

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
	assertDeployed(address, functionName);
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

	const limit = (gas * 130n) / 100n + APPEND_ALLOWANCE;
	const hash = await oneAtATime(`${account.address}.${String(chain.id)}`, () =>
		walletClient.writeContract({
			address,
			abi,
			functionName,
			args,
			chain,
			account,
			gas: limit,
			maxFeePerGas: fees.maxFeePerGas * 3n,
			maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
			value,
		} as unknown as Parameters<typeof walletClient.writeContract>[0]),
	);

	return (await confirmTx(publicClient, hash, functionName, limit)).hash;
}

/**
 * Wait for `hash` to be mined and throw unless it is what took effect.
 *
 * - A mined revert still yields a receipt; without the status check it reads as success.
 * - viem resolves with the REPLACEMENT's receipt when another transaction takes the
 *   nonce (a second process on the same key, a wallet "cancel"). That receipt says
 *   nothing about this call, so only a reprice (same to, value and data: a wallet
 *   speed-up) counts.
 * - A timeout is not a failure: the transaction may still land. Say so, so nobody
 *   resends blind (a push resent onto its own landed head reverts as stale).
 */
export async function confirmTx(
	publicClient: PublicClient,
	hash: Hash,
	what: string,
	gasLimit?: bigint,
): Promise<{ receipt: TransactionReceipt; hash: Hash }> {
	let replaced: { reason: string; hash: Hash } | undefined;
	let receipt: TransactionReceipt;
	try {
		receipt = await publicClient.waitForTransactionReceipt({
			hash,
			onReplaced: (r) => {
				replaced = {
					reason: r.reason,
					hash: r.transactionReceipt.transactionHash,
				};
			},
		});
	} catch (err) {
		if (err instanceof WaitForTransactionReceiptTimeoutError)
			throw new Error(
				`${what}: tx ${hash} was not confirmed in time. It may still land — re-read the chain before retrying.`,
				{ cause: err },
			);
		throw err;
	}
	if (replaced && replaced.reason !== "repriced")
		throw new Error(
			`${what}: tx ${hash} was ${replaced.reason} by tx ${replaced.hash} (another transaction took its nonce); it did not take effect`,
		);
	const mined = replaced?.hash ?? hash;
	if (receipt.status !== "success")
		throw new Error(
			`${what} reverted in tx ${mined}` +
				(gasLimit === undefined
					? ""
					: ` (gasUsed ${String(receipt.gasUsed)} of ${String(gasLimit)})`),
		);
	return { receipt, hash: mined };
}

/**
 * A call to the zero address (an undeployed network's placeholder) runs no code, so
 * it estimates, mines and reports success while doing nothing.
 */
function assertDeployed(address: Address, functionName: string): void {
	if (address.toLowerCase() === zeroAddress)
		throw new Error(
			`${functionName}: the contract address is the zero address — this network's contract is not deployed (or not configured)`,
		);
}

/** Guard for clients that accept a read-only construction. */
export function requireWallet(
	walletClient: WalletClient | undefined,
	what: string,
): WalletClient {
	if (!walletClient) {
		throw new Error(
			`${what} requires a wallet client; this client is read-only`,
		);
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
	assertDeployed(address, functionName);
	const data = encodeFunctionData({
		abi,
		functionName,
		args,
	} as unknown as Parameters<typeof encodeFunctionData>[0]);
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
