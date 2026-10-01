import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["ask-user-question/**/*.upstream.test.ts"],
		setupFiles: ["./test/setup.ts"],
		hookTimeout: 30_000,
		clearMocks: true,
		restoreMocks: true,
	},
});
