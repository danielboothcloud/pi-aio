// Scratch provider extension for pig checks: the "fixture" provider talks
// to test/.pigcheck/fixture_server.py on FIXTURE_PORT. No real model calls.
export default function (pi: { registerProvider: (name: string, config: unknown) => void }) {
	const port = process.env.FIXTURE_PORT ?? "1";
	pi.registerProvider("fixturer", {
		api: "openai-completions",
		baseUrl: `http://127.0.0.1:${port}/v1`,
		apiKey: "offline-fixture",
		models: [
			{
				id: "m2",
				name: "Fixture reasoning",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 2048,
			},
		],
	});
}
