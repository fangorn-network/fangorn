import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["**/*e2e.test.ts"],
		// Every file signs with the same wallet; in parallel they race for nonces.
		fileParallelism: false,
	},
});
