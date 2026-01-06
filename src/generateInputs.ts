// import { createRequire } from "module";
// const require = createRequire(import.meta.url);
// const blake = require('blake3-js'); // Or any blake3 lib
// import { blake3 } from '@noble/hashes/blake3';

import { blake3 } from "@noble/hashes/blake3.js";

export default async function generateInputs() {
	const password = Buffer.alloc(32, 1); // dummy password
	const address = Buffer.alloc(32, 2); // dummy address
	const vaultId = Buffer.alloc(32, 3); // dummy vault

	const expectedHash = await blake3(password);

	// Concat the same way the circuit does
	const nullifierInput = Buffer.concat([password, address, vaultId]);
	const nullifier = await blake3(nullifierInput);

	console.log(Buffer.alloc(32, 1));
	// console.log(`expected_hash = ${expectedHash}`);
	// console.log(`user_address = "0x${address.toString('hex')}"`);
	// console.log(`vault_id = "0x${vaultId.toString('hex')}"`);
	// console.log(`nullifier = "0x${nullifier}"`);
}
