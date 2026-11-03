import type { Hex } from "viem";
import { hexToBytes } from "viem";
import { repoId } from "../contracts/data-registry/index.js";
import {
	WHOLE_REPO,
	recordKey,
	termsToJson,
} from "../contracts/settlement-registry/index.js";
import {
	makeDeposit,
	newRepoKey,
	requestKey,
	sealField,
	type Deposit,
	type PaidScope,
} from "../crypto/paid.js";
import type { RecordInput } from "../engine/index.js";
import type { Fangorn } from "../fangorn.js";

export interface SellOptions {
	/** Payload fields to seal. A record with none of them is left as it is. */
	fields: string[];
	/** USDC base units (6 decimals). */
	price: bigint;
	/** The referrer's share, 0..10000. Through Barliman the referrer is Fangorn's treasury. */
	shareBps: number;
	/** Unix seconds after which the terms can't be bought. */
	deadline: bigint;
	/** Key server for a new deposit; the deposit names it for good. An existing deposit keeps its own. */
	keyServer?: string;
}

/**
 * Make records sellable: seal `fields` of each record (as JSON, under `field-v1`), and add the
 * publisher's signed terms under "@terms". Returns the records to commit, plus the repo's
 * `@deposit/<generation>` record if the repo had none for this generation.
 *
 * The deposit is read from the repo's on-chain head. Commit and push this before sealing more:
 * a second call before the push makes a second deposit, and the first commit's fields would
 * only open under the deposit it replaced.
 */
export async function sealRecords(
	fangorn: Fangorn,
	repo: string,
	records: RecordInput[],
	o: SellOptions,
): Promise<RecordInput[]> {
	const settlement = fangorn.getSettlementRegistry();
	const publisher = fangorn.getAddress();
	const rid = repoId(repo);
	const generation = await settlement.generationOf(publisher, rid);
	const scope: PaidScope = {
		chainId: fangorn.getConfig().chain.id,
		registry: settlement.getAddress(),
		publisher,
		repo: rid,
		generation,
	};
	const depositId = `@deposit/${generation.toString()}`;
	const wallet = fangorn.getWalletClient();
	const signer = {
		signMessage: (m: { message: { raw: Hex } }) =>
			wallet.signMessage({ account: wallet.account ?? publisher, ...m }),
	};

	const out: RecordInput[] = [];
	let kRepo: Uint8Array;
	const existing = (
		await fangorn.engine
			.readRecord(publisher, repo, depositId)
			.catch(() => null)
	)?.payload as Deposit | undefined;
	if (existing) {
		kRepo = await requestKey({ deposit: existing, key: WHOLE_REPO, signer });
	} else {
		if (!o.keyServer)
			throw new Error(
				"no key server: pass keyServer (CLI: --key-server)",
			);
		const res = await fetch(`${o.keyServer}/pubkey`);
		if (!res.ok)
			throw new Error(
				`key server ${o.keyServer}/pubkey: HTTP ${res.status.toString()}`,
			);
		const { pubkey } = (await res.json()) as { pubkey: Hex };
		kRepo = newRepoKey();
		const deposit = makeDeposit({
			kRepo,
			keyServerPubkey: hexToBytes(pubkey),
			keyServer: o.keyServer,
			scope,
		});
		out.push({
			id: depositId,
			type: "deposit",
			payload: deposit as unknown as Record<string, unknown>,
		});
	}

	const enc = new TextEncoder();
	for (const r of records) {
		const payload = { ...r.payload };
		const paid = o.fields.filter((f) => f in payload);
		if (!paid.length) {
			out.push(r);
			continue;
		}
		if (!r.id)
			throw new Error(`a record with paid fields needs an id (type ${r.type})`);
		const key = recordKey(r.id);
		for (const field of paid) {
			payload[field] = await sealField({
				plaintext: enc.encode(JSON.stringify(payload[field])),
				kRepo,
				scope,
				key,
				field,
				storage: fangorn.getStorage(),
			});
		}
		payload["@terms"] = termsToJson(
			await settlement.signTerms({
				repo: rid,
				key,
				price: o.price,
				shareBps: o.shareBps,
				deadline: o.deadline,
				generation,
			}),
		);
		out.push({ ...r, payload });
	}
	return out;
}
