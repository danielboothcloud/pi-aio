import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const binary = process.env.AIO_RECIPES_SMOKE_PI;
const repo = fileURLToPath(new URL("../", import.meta.url));

test("compiled Pi restores a .pi-recipe scope on --continue without replacing the saved recipe", {
	skip: !binary, timeout: 120_000,
}, () => {
	assert.ok(binary);
	const root = mkdtempSync(join(repo, "test/.recipe-continue-smoke-"));
	try {
		const agent = join(root, "agent");
		const home = join(root, "home");
		const tmp = join(root, "tmp");
		const sessions = join(root, "sessions");
		for (const dir of [join(agent, "extensions"), home, tmp, sessions]) mkdirSync(dir, { recursive: true });
		const reportPath = join(root, "report.json");
		const callPath = join(root, "unexpected-model-call");
		writeFileSync(join(agent, "settings.json"), JSON.stringify({ quietStartup: true }));
		writeFileSync(join(agent, "extensions/bootstrap.ts"), `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerRecipes } from ${JSON.stringify(join(repo, "recipes/index.ts"))};
import { recordRecipeFileTrust } from ${JSON.stringify(join(repo, "recipes/trust.ts"))};
export default async function(pi) {
	pi.registerProvider("fixture", {
		api: "openai-completions", baseUrl: "https://example.invalid", apiKey: "offline-fixture",
		models: ["one", "two"].map(id => ({
			id, name: id, reasoning: false, input: ["text"],
			cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, contextWindow: 128000, maxTokens: 2048,
		})),
		streamSimple: () => {
			writeFileSync(${JSON.stringify(callPath)}, "unexpected");
			throw new Error("No model requests allowed");
		},
	});
	// Explicit test-only trust, pinned to this sandbox's current file contents.
	recordRecipeFileTrust(join(process.cwd(), ".pi-recipe"), true);
	await registerRecipes(pi);
	pi.on("session_start", (_, ctx) => writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify({
		file: ctx.sessionManager.getSessionFile(), header: ctx.sessionManager.getHeader(),
		entries: ctx.sessionManager.getEntries(), scope: ctx.scopedModels.map(s => s.model.provider + "/" + s.model.id),
	})));
}
`);
		function recipe(defaultRecipe = "work", target = "fixture/one") {
			writeFileSync(join(root, ".pi-recipe"), JSON.stringify({ defaultRecipe, recipes: {
				work: { model: target, models: [target] }, other: { models: ["fixture/two"] },
			} }));
		}
		function run(args: string[], status = 0) {
			rmSync(reportPath, { force: true });
			const commands = [
				{ id: "cycle", type: "cycle_model" }, { id: "after", type: "get_state" },
			];
			const result = spawnSync(resolve(binary!), [
				...args, "--mode", "rpc", "--offline", "--session-dir", sessions,
			], {
				cwd: root, env: {
					PATH: process.env.PATH, HOME: home, TMPDIR: tmp, SystemRoot: process.env.SystemRoot,
					PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1",
				},
				input: commands.map(command => JSON.stringify(command)).join("\n") + "\n",
				encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
			});
			assert.ifError(result.error);
			assert.equal(result.status, status, result.stderr);
			assert.equal(existsSync(callPath), false);
			return result;
		}
		function report() {
			return JSON.parse(readFileSync(reportPath, "utf8")) as {
				file: string; header: unknown; entries: Array<{ id: string; customType?: string; data?: { name?: string | null } }>; scope: string[];
			};
		}
		recipe();
		const fresh = run([]);
		assert.match(fresh.stderr, /restarting pi with recipe/);
		const initial = report();
		assert.deepEqual(initial.scope, ["fixture/one"]);
		assert.ok(initial.entries.some(entry => entry.customType === "recipe-state" && entry.data?.name === "work"));
		// Persist the startup snapshot without needing a real assistant request.
		// Pi normally flushes these entries after the first assistant message.
		writeFileSync(initial.file, [initial.header, ...initial.entries].map(entry => JSON.stringify(entry)).join("\n") + "\n");

		recipe("other"); // A new cwd default must NOT replace the session's work recipe.
		const continued = run(["--continue"]);
		assert.equal((continued.stderr.match(/restarting pi with recipe/g) ?? []).length, 1);
		assert.match(continued.stderr, /continued session/);
		assert.equal(report().file, initial.file);
		assert.deepEqual(report().scope, ["fixture/one"]);
		const records = continued.stdout.split("\n").filter(Boolean).map(line => JSON.parse(line));
		assert.equal(records.find(record => record.id === "after")?.data?.model?.id, "one", "cycling stays scoped after continue");
		assert.equal(report().entries.filter(entry => entry.customType === "recipe-state").length, 1, "resume does not re-pin the recipe");

		const overridden = run(["-c", "--models", "fixture/two"]);
		assert.doesNotMatch(overridden.stderr, /restarting pi/);
		assert.deepEqual(report().scope, ["fixture/two"]);

		recipe("other", "fixture/missing");
		const missing = run(["--continue"], 1);
		assert.match(missing.stderr, /no available models matched fixture\/missing/);
		assert.equal(existsSync(reportPath), false, "stop before later startup handlers");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
