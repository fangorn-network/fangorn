import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/e2e/**/*.e2e.test.ts"],
		// Each file starts its own anvil, but they share one forge build directory.
		fileParallelism: false,
	},
});
