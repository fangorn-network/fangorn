import { describe, it, expect } from "vitest";
import {
	concat,
	createWalletClient,
	custom,
	encodeAbiParameters,
	keccak256,
	recoverTypedDataAddress,
	toHex,
	type Address,
	type Hex,
	type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { repoId } from "../data-registry/index.js";
import {
	SettlementRegistryClient,
	TERMS_TYPES,
	WHOLE_REPO,
	recordKey,
	registerNonce,
	settlementDomain,
	subjectOf,
	type SettlementPayment,
	type Terms,
} from "./index.js";

const REGISTRY = "0x00000000000000000000000000000000000000aa" as Address;
const REFERRER = "0x0000000000000000000000000000000000C0FFEE" as Address;
const CHAIN_ID = 84532;
const account = privateKeyToAccount(("0x" + "11".repeat(32)) as Hex);

// Vectors from `cast keccak` / `cast abi-encode`, independent of viem.
const REPO =
	"0xcd1fc5d85bdded8b0630defd88ef40970061fefa33a2a2b7260f4897a0783ed5" as Hex;
const KEY =
	"0x44726559b9df017a702bd4559fb03b3fae755597b8586ead0cb8246c0aa09de2" as Hex;
const SUBJECT =
	"0xad4f426e51504d57843f2ac91ad6fed6eb06a4f17807df026173426ae31de4a2" as Hex;
const NONCE =
	"0x7f4a6486ed8097e815b3be8f5f5e7ae2411dbcad2e885d020262d591f4c5cd1f" as Hex;
const VECTOR_PUBLISHER =
	"0x00000000000000000000000000000000000000aa" as Address;

/** The contract's TERMS_TYPEHASH string, verbatim. */
const TERMS_TYPE =
	"Terms(address publisher,bytes32 repo,bytes32 key,uint256 price,uint16 shareBps,uint64 generation,uint64 deadline)";

function client(
	opts: { generation?: bigint; wallet?: boolean; reverted?: boolean } = {},
) {
	const writes: { functionName: string; args: readonly unknown[] }[] = [];
	const reads: { functionName: string; args: readonly unknown[] }[] = [];
	const publicClient = {
		getChainId: () => Promise.resolve(CHAIN_ID),
		readContract: ({
			functionName,
			args,
		}: {
			functionName: string;
			args: readonly unknown[];
		}) => {
			reads.push({ functionName, args });
			return Promise.resolve(
				functionName === "generationOf" ? (opts.generation ?? 0n) : true,
			);
		},
		getBlock: () => Promise.resolve({ timestamp: 1n }),
		estimateFeesPerGas: () =>
			Promise.resolve({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
		estimateContractGas: () => Promise.resolve(1n),
		waitForTransactionReceipt: () =>
			Promise.resolve({
				status: opts.reverted ? "reverted" : "success",
				gasUsed: 1n,
			}),
	} as unknown as PublicClient;
	const walletClient = createWalletClient({
		account,
		chain: baseSepolia,
		transport: custom({ request: () => Promise.reject(new Error("no rpc")) }),
	});
	walletClient.writeContract = ((q: {
		functionName: string;
		args: readonly unknown[];
	}) => {
		writes.push({ functionName: q.functionName, args: q.args });
		return Promise.resolve("0xhash");
	}) as typeof walletClient.writeContract;
	const reg = new SettlementRegistryClient(
		REGISTRY,
		publicClient,
		opts.wallet === false ? undefined : walletClient,
	);
	return { reg, writes, reads };
}

const terms = (price: bigint): Terms => ({
	publisher: account.address,
	repo: REPO,
	key: KEY,
	price,
	shareBps: 2000,
	generation: 0n,
	deadline: 2_000_000_000n,
});

const payment: SettlementPayment = {
	from: "0x0000000000000000000000000000000000000B0B",
	value: 1_000_000n,
	validAfter: 0n,
	validBefore: 99n,
	nonce: NONCE,
	v: 27,
	r: ("0x" + "01".repeat(32)) as Hex,
	s: ("0x" + "02".repeat(32)) as Hex,
};

describe("ids", () => {
	it("match the contract's derivations", () => {
		expect(repoId("photos")).toBe(REPO);
		expect(recordKey("photos/tabby.jpg")).toBe(KEY);
		expect(subjectOf(VECTOR_PUBLISHER, REPO, KEY)).toBe(SUBJECT);
		expect(
			registerNonce(SUBJECT, 1234n, REFERRER, toHex(7n, { size: 32 })),
		).toBe(NONCE);
	});

	it("defaults to the whole repo", () => {
		expect(subjectOf(VECTOR_PUBLISHER, REPO)).toBe(
			subjectOf(VECTOR_PUBLISHER, REPO, WHOLE_REPO),
		);
		expect(subjectOf(VECTOR_PUBLISHER, REPO)).not.toBe(SUBJECT);
	});
});

describe("signTerms", () => {
	it("signs as the wallet, at the chain's generation, recoverably", async () => {
		const { reg, reads } = client({ generation: 3n });
		const { terms: t, signature } = await reg.signTerms({
			repo: REPO,
			key: KEY,
			price: 5n,
			shareBps: 2500,
			deadline: 9n,
		});
		expect(t.publisher).toBe(account.address);
		expect(t.generation).toBe(3n);
		expect(reads).toEqual([
			{ functionName: "generationOf", args: [account.address, REPO] },
		]);
		const signer = await recoverTypedDataAddress({
			domain: settlementDomain(CHAIN_ID, REGISTRY),
			types: TERMS_TYPES,
			primaryType: "Terms",
			message: t,
			signature,
		});
		expect(signer).toBe(account.address);
	});

	it("keeps an explicit generation without reading the chain", async () => {
		const { reg, reads } = client({ generation: 3n });
		const { terms: t } = await reg.signTerms({
			repo: REPO,
			key: KEY,
			price: 5n,
			shareBps: 0,
			deadline: 9n,
			generation: 1n,
		});
		expect(t.generation).toBe(1n);
		expect(reads).toEqual([]);
	});

	it("hashes exactly as the contract's EIP-712 type", async () => {
		const { reg } = client();
		const { terms: t, signature } = await reg.signTerms({
			repo: REPO,
			key: KEY,
			price: 5n,
			shareBps: 2500,
			deadline: 9n,
		});
		const domainType =
			"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
		const domainSeparator = keccak256(
			encodeAbiParameters(
				[
					{ type: "bytes32" },
					{ type: "bytes32" },
					{ type: "bytes32" },
					{ type: "uint256" },
					{ type: "address" },
				],
				[
					keccak256(toHex(domainType)),
					keccak256(toHex("Fangorn Settlement")),
					keccak256(toHex("1")),
					BigInt(CHAIN_ID),
					REGISTRY,
				],
			),
		);
		const structHash = keccak256(
			encodeAbiParameters(
				[
					{ type: "bytes32" },
					{ type: "address" },
					{ type: "bytes32" },
					{ type: "bytes32" },
					{ type: "uint256" },
					{ type: "uint16" },
					{ type: "uint64" },
					{ type: "uint64" },
				],
				[
					keccak256(toHex(TERMS_TYPE)),
					t.publisher,
					t.repo,
					t.key,
					t.price,
					t.shareBps,
					t.generation,
					t.deadline,
				],
			),
		);
		const digest = keccak256(concat(["0x1901", domainSeparator, structHash]));
		expect(await account.sign({ hash: digest })).toBe(signature);
	});

	it.each([10_001, -1, 1.5])("rejects shareBps %s", async (shareBps) => {
		const { reg } = client();
		await expect(
			reg.signTerms({
				repo: REPO,
				key: KEY,
				price: 5n,
				shareBps,
				deadline: 9n,
			}),
		).rejects.toThrow(/shareBps/);
	});

	it("needs a wallet", async () => {
		const { reg } = client({ wallet: false });
		await expect(
			reg.signTerms({
				repo: REPO,
				key: KEY,
				price: 5n,
				shareBps: 0,
				deadline: 9n,
			}),
		).rejects.toThrow();
	});
});

describe("writes", () => {
	it("register passes the contract's argument order", async () => {
		const { reg, writes } = client();
		const t = terms(1_000_000n);
		await reg.register({
			terms: t,
			signature: "0xsig",
			commitment: 1234n,
			referrer: REFERRER,
			salt: toHex(7n, { size: 32 }),
			payment,
		});
		expect(writes).toEqual([
			{
				functionName: "register",
				args: [t, "0xsig", 1234n, REFERRER, toHex(7n, { size: 32 }), payment],
			},
		]);
	});

	it("register sends an empty payment for a free subject", async () => {
		const { reg, writes } = client();
		await reg.register({
			terms: terms(0n),
			signature: "0xsig",
			commitment: 1n,
			referrer: REFERRER,
			salt: toHex(0n, { size: 32 }),
			payment,
		});
		const sent = writes[0].args[5] as SettlementPayment;
		expect(sent.value).toBe(0n);
		expect(sent.from).toBe("0x0000000000000000000000000000000000000000");
	});

	it("settle passes the contract's argument order", async () => {
		const { reg, writes } = client();
		const points = [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n] as const;
		await reg.settle({
			subject: SUBJECT,
			reader: REFERRER,
			merkleTreeDepth: 20n,
			merkleTreeRoot: 99n,
			nullifier: 42n,
			points,
		});
		expect(writes).toEqual([
			{
				functionName: "settle",
				args: [SUBJECT, REFERRER, 20n, 99n, 42n, points],
			},
		]);
	});

	it("publisher writes", async () => {
		const { reg, writes } = client();
		await reg.raiseGeneration(REPO);
		await reg.setDenied(REFERRER, true);
		await reg.setDisabled(REPO, KEY, true);
		expect(writes).toEqual([
			{ functionName: "raiseGeneration", args: [REPO] },
			{ functionName: "setDenied", args: [REFERRER, true] },
			{ functionName: "setDisabled", args: [account.address, REPO, KEY, true] },
		]);
	});

	it("a mined revert rejects instead of returning the hash", async () => {
		const { reg } = client({ reverted: true });
		await expect(reg.raiseGeneration(REPO)).rejects.toThrow(
			/raiseGeneration reverted in tx 0xhash/,
		);
	});

	it("writes need a wallet", () => {
		const { reg } = client({ wallet: false });
		expect(() => reg.raiseGeneration(REPO)).toThrow(/wallet/);
	});
});

describe("reads", () => {
	it("canRead asks for record and repo in one call", async () => {
		const { reg, reads } = client();
		expect(await reg.canRead(REFERRER, account.address, REPO, KEY)).toBe(true);
		expect(reads).toEqual([
			{ functionName: "canRead", args: [REFERRER, account.address, REPO, KEY] },
		]);
	});
});
