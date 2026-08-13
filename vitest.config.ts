import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		clearMocks: true,
		coverage: {
			include: ["src"],
			reporter: ["html", "lcov"],
			provider: 'v8',
		},
		exclude: ["lib", "**/e2e.test.ts", "node_modules"],
		environment: "node",
		pool: "forks",
		server: {
			deps: {
				inline: [/@wagmi/, /viem/, /@noble/, /@scure/],
			},
		},
	},
});
