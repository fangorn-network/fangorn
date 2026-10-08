import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["**/*e2e.test.ts"],
		// Both e2e files sign with ETH_PRIVATE_KEY; in parallel they race for nonces.
		fileParallelism: false,
	},
});
