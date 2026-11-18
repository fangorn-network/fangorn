import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		clearMocks: true,
		coverage: {
			include: ["src/**/*.ts"],
			reporter: ["html", "lcov"],
			provider: "v8",
		},
		// dist: stale local builds of old tests (gitignored), some hit live Pinata.
		exclude: ["lib", "dist", "**/*e2e.test.ts", "node_modules"],
		environment: "node",
		pool: "forks",
		server: {
			deps: {
				inline: [/@wagmi/, /viem/, /@noble/, /@scure/],
			},
		},
	},
});
