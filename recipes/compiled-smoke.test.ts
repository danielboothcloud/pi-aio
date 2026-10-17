import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Opt-in integration test against a real compiled Pi executable. Everything
// else is a local fixture: no credentials, network, packages, or LLM calls.
// AIO_RECIPES_SMOKE_PI=/absolute/path/to/pi npx tsx --test recipes/compiled-smoke.test.ts
const binary = process.env.AIO_RECIPES_SMOKE_PI;
const repo = fileURLToPath(new URL("../", import.meta.url));

interface StartupReport {
	argv: string[];
	model?: { id: string; provider: string };
	thinking: string;
	scope: string[];
	recipe: Array<{ name: string }>;
}

interface RpcRecord {
	type: string;
	id?: string;
	success?: boolean;
	data?: {
		model?: { id: string; provider: string };
		commands?: Array<{ name: string }>;
		messages?: unknown[];
	};
}

for (const { missingModel, mode } of [
	{ missingModel: false, mode: "rpc" },
	{ missingModel: true, mode: "rpc" },
	{ missingModel: true, mode: "json" },
	{ missingModel: true, mode: "text" },
]) {
	test(
		missingModel
			? `compiled Pi rejects an unresolved scope before a prompt can run (${mode})`
			: "compiled Pi relaunch applies only the recipe extensions and Cursor scope, with no prompt",
		{ skip: !binary, timeout: 90_000 },
		() => {
			assert.ok(binary);
			const root = mkdtempSync(join(repo, "test/.recipe-startup-"));
			try {
				const agent = join(root, "agent");
				const home = join(root, "home");
				const tmp = join(root, "tmp");
				for (const directory of [join(agent, "extensions"), home, tmp]) {
					mkdirSync(directory, { recursive: true });
				}
				const reportPath = join(root, "report.json");
				const callPath = join(root, "unexpected-model-call");
				const provider = join(root, "work-provider.js");
				const targetModel = missingModel ? "cursor/unavailable-model" : "cursor/grok-4.7";

				// Discovery loads the bridge without an explicit -e (which would
				// otherwise override recipe.extensions). The child must suppress
				// both this bootstrap and the unrelated global extension via -ne.
				writeFileSync(join(agent, "extensions/bootstrap.ts"), `
import { registerRecipes } from ${JSON.stringify(join(repo, "recipes/index.ts"))};
export default async function(pi) { await registerRecipes(pi); }
`);
				const globalOnly = join(root, "global-only.js");
				writeFileSync(globalOnly, `export default function(pi) {
	pi.registerCommand("global_only_probe", {handler: async () => {}});
}`);
				writeFileSync(provider, `
import { writeFileSync } from "node:fs";
export default function(pi) {
	pi.registerProvider("cursor", {
		api: "openai-completions", baseUrl: "https://example.invalid", apiKey: "offline-fixture",
		models: ["grok-4.7", "other-model"].map(id => ({
			id, name: id, reasoning: true, thinkingLevelMap: {xhigh: "xhigh"}, input: ["text"],
			cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, contextWindow: 128000, maxTokens: 2048,
		})),
		streamSimple: () => {
			writeFileSync(${JSON.stringify(callPath)}, "unexpected");
			throw new Error("LLM calls are forbidden in this startup smoke test");
		},
	});
	pi.registerCommand("work_provider_probe", {handler: async () => {}});
	pi.on("session_start", (_, ctx) => writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify({
		argv: process.argv,
		model: ctx.model && {id: ctx.model.id, provider: ctx.model.provider},
		thinking: pi.getThinkingLevel(),
		scope: ctx.scopedModels.map(s => s.model.provider + "/" + s.model.id),
		recipe: ctx.sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === "recipe-state").map(e => e.data),
	})));
}
`);
				writeFileSync(join(agent, "settings.json"), JSON.stringify({
					extensions: [globalOnly], defaultProvider: "cursor", defaultModel: "other-model", quietStartup: true,
				}));
				writeFileSync(join(agent, "aio-recipes.json"), JSON.stringify({ recipes: { work: {
					model: targetModel, thinkingLevel: "xhigh", models: [targetModel], extensions: [provider],
				} } }));
				const commands = [
					{ id: "before", type: "get_state" },
					{ id: "cycle", type: "cycle_model" },
					{ id: "after", type: "get_state" },
					{ id: "commands", type: "get_commands" },
					{ id: "messages", type: "get_messages" },
				];
				const result = spawnSync(resolve(binary), [
					"--recipe", "work", "--mode", mode, "--offline", "--no-session", "--no-approve",
					...(mode === "rpc" ? [] : ["-p", "This prompt must never reach the fallback model"]),
				], {
					cwd: root,
					env: {
						PATH: process.env.PATH, HOME: home, TMPDIR: tmp, SystemRoot: process.env.SystemRoot,
						PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1",
					},
					input: mode === "rpc" ? commands.map(command => JSON.stringify(command)).join("\n") + "\n" : "",
					encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
				});
				assert.ifError(result.error);
				assert.equal(result.status, missingModel ? 1 : 0, result.stderr);
				assert.equal(existsSync(callPath), false, "startup must never send an LLM request");
				assert.equal((result.stderr.match(/restarting pi with recipe/g) ?? []).length, 1);
				if (missingModel) {
					assert.match(result.stderr, /no available models matched cursor\/unavailable-model/);
					assert.match(result.stderr, /Stopping instead of enabling all models/);
					assert.equal(existsSync(reportPath), false, "invalid scope exits before later startup handlers or RPC commands");
					return;
				}
				// SAFETY: the report is generated by our local fixture above.
				const report = JSON.parse(readFileSync(reportPath, "utf8")) as StartupReport;
				assert.deepEqual(report.argv.slice(2).filter(arg => /\$bunfs|~BUN/i.test(arg)), []);
				assert.deepEqual(report.model, { id: "grok-4.7", provider: "cursor" });
				assert.equal(report.thinking, "xhigh");
				assert.deepEqual(report.scope, ["cursor/grok-4.7"]);
				assert.deepEqual(report.recipe, [{ name: "work" }]);
				// SAFETY: stdout is Pi's documented RPC JSONL, inspected without
				// prompting; malformed or unexpected records fail the assertions.
				const records = result.stdout.split("\n").filter(Boolean).map(line => JSON.parse(line)) as RpcRecord[];
				for (const id of ["before", "after"]) {
					const response = records.find(record => record.id === id);
					assert.equal(response?.success, true);
					assert.equal(response.data?.model?.id, "grok-4.7", "cycling stays in the one-model scope");
				}
				const names = records.find(record => record.id === "commands")?.data?.commands?.map(command => command.name);
				assert.ok(names, "RPC returns the command list");
				assert.ok(names.includes("recipe"));
				assert.ok(names.includes("work_provider_probe"));
				assert.equal(names.includes("global_only_probe"), false);
				assert.deepEqual(records.find(record => record.id === "messages")?.data?.messages, []);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	);
}
