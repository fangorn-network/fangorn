import { describe } from "vitest";
import { sdkSuite } from "../test/sdk-suite.js";
import { chainNetwork, skipChain } from "../test/testbed.js";

// The SDK suite on the contracts: built from ../contracts/solidity, deployed to
// a fresh anvil. Storage is in memory unless E2E_STORAGE=pinata.
describe.skipIf(skipChain)("Fangorn SDK (contracts on anvil)", () => {
	sdkSuite(chainNetwork, 60_000);
});
