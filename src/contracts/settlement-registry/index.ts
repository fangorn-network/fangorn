import {
	encodeAbiParameters,
	keccak256,
	toHex,
	zeroHash,
	type Abi,
	type Address,
	type Hash,
	type Hex,
	type PublicClient,
	type TypedDataDomain,
	type WalletClient,
} from "viem";

import { SETTLEMENT_REGISTRY_ABI } from "./abi.js";
import { requireWallet, sendWrite } from "../write.js";

/** The key of a whole-repo subject. */
export const WHOLE_REPO: Hex = zeroHash;

/** What a publisher signs: the price of one subject, and the referrer's share of it. */
export interface Terms {
	publisher: Address;
	/** `repoId(name)` */
	repo: Hex;
	/** `recordKey(id)`, or `WHOLE_REPO` */
	key: Hex;
	/** USDC base units */
	price: bigint;
	/** 0..10000 */
	shareBps: number;
	generation: bigint;
	/** unix seconds */
	deadline: bigint;
}

/** A signed ERC-3009 `receiveWithAuthorization` paying the registry. */
export interface SettlementPayment {
	from: Address;
	value: bigint;
	validAfter: bigint;
	validBefore: bigint;
	nonce: Hex;
	v: number;
	r: Hex;
	s: Hex;
}

export interface RegisterArgs {
	terms: Terms;
	signature: Hex;
	commitment: bigint;
	/** zero address for none */
	referrer: Address;
	salt: Hex;
	/** ignored by the contract when the price is zero */
	payment: SettlementPayment;
}

/** A Semaphore proof over the subject's group, with `reader` as its message. */
export interface SettleArgs {
	subject: Hex;
	reader: Address;
	merkleTreeDepth: bigint;
	merkleTreeRoot: bigint;
	nullifier: bigint;
	points: readonly [
		bigint,
		bigint,
		bigint,
		bigint,
		bigint,
		bigint,
		bigint,
		bigint,
	];
}

const ZERO_PAYMENT: SettlementPayment = {
	from: "0x0000000000000000000000000000000000000000",
	value: 0n,
	validAfter: 0n,
	validBefore: 0n,
	nonce: zeroHash,
	v: 0,
	r: zeroHash,
	s: zeroHash,
};

export const TERMS_TYPES = {
	Terms: [
		{ name: "publisher", type: "address" },
		{ name: "repo", type: "bytes32" },
		{ name: "key", type: "bytes32" },
		{ name: "price", type: "uint256" },
		{ name: "shareBps", type: "uint16" },
		{ name: "generation", type: "uint64" },
		{ name: "deadline", type: "uint64" },
	],
} as const;

export const settlementDomain = (
	chainId: number,
	registry: Address,
): TypedDataDomain => ({
	name: "Fangorn Settlement",
	version: "1",
	chainId,
	verifyingContract: registry,
});

/** A record's key within its repo. */
export const recordKey = (id: string): Hex => keccak256(toHex(id));

export const subjectOf = (
	publisher: Address,
	repo: Hex,
	key: Hex = WHOLE_REPO,
): Hex =>
	keccak256(
		encodeAbiParameters(
			[{ type: "address" }, { type: "bytes32" }, { type: "bytes32" }],
			[publisher, repo, key],
		),
	);

/** The nonce a payer signs for `register`. */
export const registerNonce = (
	subject: Hex,
	commitment: bigint,
	referrer: Address,
	salt: Hex,
): Hex =>
	keccak256(
		encodeAbiParameters(
			[
				{ type: "bytes32" },
				{ type: "uint256" },
				{ type: "address" },
				{ type: "bytes32" },
			],
			[subject, commitment, referrer, salt],
		),
	);

/**
 * Client for the SettlementRegistry.
 *
 * Publishers sign terms (no transaction) and manage generations, denials and takedowns.
 * `register` and `settle` take what a buyer signed and proved, so anyone may submit them.
 * Semaphore identities and proofs live with the buyer, not here.
 */
export class SettlementRegistryClient {
	constructor(
		private contractAddress: Address,
		private publicClient: PublicClient,
		private walletClient?: WalletClient,
	) {}

	getAddress(): Address {
		return this.contractAddress;
	}

	private write(functionName: string, args: readonly unknown[]): Promise<Hash> {
		return sendWrite(
			this.publicClient,
			requireWallet(this.walletClient, functionName),
			this.contractAddress,
			SETTLEMENT_REGISTRY_ABI as unknown as Abi,
			functionName,
			args,
		);
	}

	private read<T>(
		functionName: string,
		args: readonly unknown[] = [],
	): Promise<T> {
		return this.publicClient.readContract({
			address: this.contractAddress,
			abi: SETTLEMENT_REGISTRY_ABI as unknown as Abi,
			functionName,
			args,
		}) as Promise<T>;
	}

	// ── Publisher ──

	/** Sign terms as this client's wallet, at the repo's current generation unless given. */
	async signTerms(
		t: Omit<Terms, "publisher" | "generation"> & { generation?: bigint },
	): Promise<{ terms: Terms; signature: Hex }> {
		const wallet = requireWallet(this.walletClient, "signTerms");
		const account = wallet.account;
		if (!account)
			throw new Error("signTerms: the wallet client has no account");
		if (
			!Number.isInteger(t.shareBps) ||
			t.shareBps < 0 ||
			t.shareBps > 10_000
		) {
			throw new Error(
				`signTerms: shareBps must be an integer in 0..10000, got ${String(t.shareBps)}`,
			);
		}
		const terms: Terms = {
			...t,
			publisher: account.address,
			generation:
				t.generation ?? (await this.generationOf(account.address, t.repo)),
		};
		const signature = await wallet.signTypedData({
			account,
			domain: settlementDomain(
				await this.publicClient.getChainId(),
				this.contractAddress,
			),
			types: TERMS_TYPES,
			primaryType: "Terms",
			message: terms,
		});
		return { terms, signature };
	}

	raiseGeneration(repo: Hex): Promise<Hash> {
		return this.write("raiseGeneration", [repo]);
	}

	setDenied(referrer: Address, denied: boolean): Promise<Hash> {
		return this.write("setDenied", [referrer, denied]);
	}

	/** Takes down (or restores) one of this wallet's own subjects. */
	setDisabled(repo: Hex, key: Hex, disabled: boolean): Promise<Hash> {
		const account = requireWallet(this.walletClient, "setDisabled").account;
		if (!account)
			throw new Error("setDisabled: the wallet client has no account");
		return this.write("setDisabled", [account.address, repo, key, disabled]);
	}

	// ── Buyer (relayable) ──

	register(a: RegisterArgs): Promise<Hash> {
		const payment = a.terms.price === 0n ? ZERO_PAYMENT : a.payment;
		return this.write("register", [
			a.terms,
			a.signature,
			a.commitment,
			a.referrer,
			a.salt,
			payment,
		]);
	}

	settle(a: SettleArgs): Promise<Hash> {
		return this.write("settle", [
			a.subject,
			a.reader,
			a.merkleTreeDepth,
			a.merkleTreeRoot,
			a.nullifier,
			a.points,
		]);
	}

	// ── Reads ──

	generationOf(publisher: Address, repo: Hex): Promise<bigint> {
		return this.read("generationOf", [publisher, repo]);
	}

	isDenied(publisher: Address, referrer: Address): Promise<boolean> {
		return this.read("isDenied", [publisher, referrer]);
	}

	isDisabled(subject: Hex): Promise<boolean> {
		return this.read("isDisabled", [subject]);
	}

	isRegistered(subject: Hex, commitment: bigint): Promise<boolean> {
		return this.read("isRegistered", [subject, commitment]);
	}

	isSettled(reader: Address, subject: Hex): Promise<boolean> {
		return this.read("isSettled", [reader, subject]);
	}

	/** Settled for the record or the whole repo, and neither is disabled. */
	canRead(
		reader: Address,
		publisher: Address,
		repo: Hex,
		key: Hex,
	): Promise<boolean> {
		return this.read("canRead", [reader, publisher, repo, key]);
	}
}

/** Signed terms as a record carries them under `"@terms"`: bigints as decimal strings. */
export interface TermsJson {
	terms: Omit<Terms, "price" | "generation" | "deadline"> & {
		price: string;
		generation: string;
		deadline: string;
	};
	signature: Hex;
}

export const termsToJson = ({
	terms,
	signature,
}: {
	terms: Terms;
	signature: Hex;
}): TermsJson => ({
	terms: {
		...terms,
		price: terms.price.toString(),
		generation: terms.generation.toString(),
		deadline: terms.deadline.toString(),
	},
	signature,
});

export const termsFromJson = ({
	terms,
	signature,
}: TermsJson): { terms: Terms; signature: Hex } => ({
	terms: {
		...terms,
		price: BigInt(terms.price),
		generation: BigInt(terms.generation),
		deadline: BigInt(terms.deadline),
	},
	signature,
});
