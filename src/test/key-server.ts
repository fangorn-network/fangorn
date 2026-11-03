import { bytesToHex, hexToBytes, recoverMessageAddress, type Address, type Hex } from "viem";
import { WHOLE_REPO } from "../contracts/settlement-registry/index.js";
import { seal, unseal } from "../crypto/encryption.js";
import { accessMessage, deriveRecordKey, statement, type AccessRequest } from "../crypto/paid.js";

// A copy of fangorn-access-worker's /access (its src/access.ts), for tests. No timestamp check.
export async function testKeyServer(
	body: AccessRequest,
	ks: {
		secret: Uint8Array;
		chainId: number;
		registry: Address;
		canRead(reader: Address, publisher: Address, repo: Hex, key: Hex): Promise<boolean>;
	},
): Promise<Response> {
	const stmt = statement({ ...ks, publisher: body.publisher, repo: body.repo, generation: BigInt(body.generation) });
	const reader = await recoverMessageAddress({
		message: { raw: accessMessage(stmt, body.key, body.readerKey, body.timestamp) },
		signature: body.signature,
	});
	const own = reader.toLowerCase() === body.publisher.toLowerCase();
	if (!own && !(await ks.canRead(reader, body.publisher, body.repo, body.key))) return new Response("not settled", { status: 403 });
	let kRepo: Uint8Array;
	try {
		kRepo = unseal(hexToBytes(body.sealed), ks.secret, stmt);
	} catch {
		return new Response("deposit does not match", { status: 400 });
	}
	const out = body.key === WHOLE_REPO ? kRepo : deriveRecordKey(kRepo, stmt, body.key);
	return Response.json({ sealed: bytesToHex(seal(out, hexToBytes(body.readerKey), stmt)) });
}
