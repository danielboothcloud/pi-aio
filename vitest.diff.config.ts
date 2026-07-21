import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["diff-tools/**/*.test.ts"],
		hookTimeout: 30_000,
		clearMocks: true,
		restoreMocks: true,
	},
});
