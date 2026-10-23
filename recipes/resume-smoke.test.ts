import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";

const binary = process.env.AIO_RECIPES_SMOKE_PI;
const repo = fileURLToPath(new URL("../", import.meta.url));

for (const flow of ["direct", "picker", "switch", "switch-off", "switch-unscoped", "new"]) {
	test(`compiled Pi restores recipe extensions, model scope, thinking and MCP (${flow})`, {
		skip: !binary || (flow !== "direct" && process.platform === "win32"), timeout: 90_000,
	}, () => {
		assert.ok(binary);
		const root = mkdtempSync(join(repo, "test/.recipe-resume-smoke-"));
		try {
			const agent = join(root, "agent");
			const sessions = join(root, "sessions");
			const home = join(root, "home");
			const tmp = join(root, "tmp");
			for (const dir of [join(agent, "extensions"), sessions, home, tmp]) mkdirSync(dir, { recursive: true });
			const report = join(root, "report.json");
			const unexpected = join(root, "unexpected-model-call");
			const source = join(sessions, "source.jsonl");
			const target = join(sessions, "target.jsonl");
			function savedSession(file: string, name: string, recipe: string | null) {
				const timestamp = new Date().toISOString();
				writeFileSync(file, [
					{ type: "session", version: CURRENT_SESSION_VERSION, id: name, timestamp, cwd: root },
					{ type: "custom", id: "recipe", parentId: null, timestamp, customType: "recipe-state", data: { name: recipe } },
					{ type: "session_info", id: "name", parentId: "recipe", timestamp, name },
					{ type: "message", id: "user", parentId: "name", timestamp, message: { role: "user", content: name, timestamp: Date.now() } },
				].map(entry => JSON.stringify(entry)).join("\n") + "\n");
			}
			savedSession(source, "resume-smoke-source", "work");
			if (flow.startsWith("switch")) savedSession(target, "resume-smoke-target", flow === "switch-off" ? null : "next");
			const work = join(root, "work.ts");
			const next = join(root, "next.ts");
			for (const [path, probe] of [[work, "work_probe"], [next, "next_probe"]]) {
				writeFileSync(path, `
import { writeFileSync } from "node:fs";
export default function(pi) {
	pi.registerProvider("fixture", {
		api: "openai-completions", baseUrl: "https://example.invalid", apiKey: "offline-fixture",
		models: ["one", "two"].map(id => ({ id, name: id, reasoning: true, input: ["text"],
			cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, contextWindow: 128000, maxTokens: 2048 })),
		streamSimple: () => { writeFileSync(${JSON.stringify(unexpected)}, "unexpected"); throw new Error("No model calls allowed"); },
	});
	pi.registerCommand(${JSON.stringify(probe)}, { handler: async () => {} });
	pi.on("session_start", (event, ctx) => {
		writeFileSync(${JSON.stringify(report)}, JSON.stringify({
			reason: event.reason, entries: ctx.sessionManager.getBranch(),
			file: ctx.sessionManager.getSessionFile(), scope: ctx.scopedModels.map(s => s.model.provider + "/" + s.model.id),
			model: ctx.model && ctx.model.provider + "/" + ctx.model.id, thinking: pi.getThinkingLevel(),
			commands: pi.getCommands().map(c => c.name), mcp: pi.getMcpServers().map(s => s.name),
		}));
		if (ctx.mode === "tui" && (ctx.sessionManager.getSessionFile() === process.env.AIO_RESUME_SMOKE_STOP ||
			(process.env.AIO_RESUME_SMOKE_STOP === "after-new" && event.reason === "new"))) ctx.shutdown();
	});
}
`);
			}
			const globalOnly = join(root, "global.ts");
			writeFileSync(globalOnly, `
import { writeFileSync } from "node:fs";
export default function(pi) {
	pi.registerCommand("global_only_probe", {handler: async () => {}});
	pi.registerProvider("fixture", {api: "openai-completions", baseUrl: "https://example.invalid", apiKey: "offline-fixture",
		models: ["two"].map(id => ({id, name: id, reasoning: true, input: ["text"], cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, contextWindow: 128000, maxTokens: 2048})),
		streamSimple: () => { writeFileSync(${JSON.stringify(unexpected)}, "unexpected"); throw new Error("No model calls allowed"); },
	});
	pi.on("resources_discover", (_, ctx) => {
		writeFileSync(${JSON.stringify(report)}, JSON.stringify({
			file: ctx.sessionManager.getSessionFile(), scope: ctx.scopedModels.map(s => s.model.provider + "/" + s.model.id),
			model: ctx.model && ctx.model.provider + "/" + ctx.model.id, thinking: pi.getThinkingLevel(),
			commands: pi.getCommands().map(c => c.name), mcp: pi.getMcpServers().map(s => s.name),
		}));
		if (ctx.mode === "tui" && ctx.sessionManager.getSessionFile() === process.env.AIO_RESUME_SMOKE_STOP) ctx.shutdown();
	});
}
`);
			writeFileSync(join(agent, "settings.json"), JSON.stringify({ quietStartup: true, extensions: [globalOnly] }));
			writeFileSync(join(agent, "extensions/bootstrap.ts"), `
import { registerRecipes } from ${JSON.stringify(join(repo, "recipes/index.ts"))};
import { recordRecipeFileTrust } from ${JSON.stringify(join(repo, "recipes/trust.ts"))};
export default async pi => {
	recordRecipeFileTrust(${JSON.stringify(join(root, ".pi-recipe"))}, true);
	await registerRecipes(pi);
};
`);
			writeFileSync(join(root, ".pi-recipe"), JSON.stringify({ defaultRecipe: flow === "new" ? "work" : "next", recipes: {
				work: { model: "fixture/one", models: ["fixture/one"], thinkingLevel: "high", extensions: [work], mcpServers: { offline: { command: "unused-offline-fixture", enabled: false } } },
				next: flow === "switch-unscoped" ? { model: "fixture/two" } : { model: "fixture/two", models: ["fixture/two"], thinkingLevel: "medium", extensions: [next], mcpServers: { offline: { command: "unused-offline-fixture", enabled: false } } },
			} }));
			const env = {
				PATH: process.env.PATH, HOME: home, TMPDIR: tmp, SystemRoot: process.env.SystemRoot,
				PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", TERM: "xterm-256color",
				AIO_RESUME_SMOKE_STOP: flow === "new" ? "after-new" : flow.startsWith("switch") ? target : source,
			};
			const base = ["--offline", "--approve", "--session-dir", sessions];
			if (flow === "direct") {
				const commands = [{ id: "cycle", type: "cycle_model" }, { id: "after", type: "get_state" }];
				for (const selector of [["--continue"], ["--session", source], ["--session-id", "resume-smoke-source"]]) {
					const result = spawnSync(resolve(binary), [...base, ...selector, "--mode", "rpc"], {
						cwd: root, env, encoding: "utf8", timeout: 30_000,
						input: commands.map(command => JSON.stringify(command)).join("\n") + "\n",
					});
					assert.ifError(result.error);
					assert.equal(result.status, 0, result.stderr);
					const state = JSON.parse(readFileSync(report, "utf8"));
					assert.deepEqual(state.scope, ["fixture/one"]);
					assert.equal(state.thinking, "high");
					assert.ok(state.commands.includes("work_probe"));
					assert.ok(!state.commands.includes("global_only_probe"));
					assert.ok(state.mcp.includes("offline"));
				}
			} else {
				const result = spawnSync("python3", [join(repo, "test/recipe-resume-pty.py"), resolve(binary), report,
					flow, ...base, ...(flow === "picker" ? ["--resume"] : flow === "new" ? [] : ["--session", source])], {
					cwd: root, env, encoding: "utf8", timeout: 55_000, maxBuffer: 4 * 1024 * 1024,
				});
				assert.ifError(result.error);
				assert.equal(result.status, 0, result.stderr + result.stdout);
				const pty = JSON.parse(result.stdout);
				assert.equal(pty.status, 0, pty.output);
				assert.equal(pty.phase, "done", pty.output);
				const state = JSON.parse(readFileSync(report, "utf8"));
				if (flow === "new") {
					assert.equal(state.reason, "new");
					assert.notEqual(state.file, pty.initialFile, "/new must remain a separate conversation");
					assert.ok(state.entries.some((entry: { customType?: string; data?: { name?: string } }) => entry.customType === "recipe-state" && entry.data?.name === "work"));
					assert.equal(state.model, "fixture/one");
				} else {
					assert.equal(state.file, flow.startsWith("switch") ? target : source);
				}
				if (flow === "switch-off" || flow === "switch-unscoped") {
					assert.deepEqual(state.scope, []);
					assert.ok(state.commands.includes("global_only_probe"));
					assert.ok(!state.commands.includes("work_probe"));
					assert.ok(!state.commands.includes("next_probe"));
					assert.deepEqual(state.mcp, []);
					if (flow === "switch-unscoped") assert.equal(state.model, "fixture/two");
				} else {
					assert.deepEqual(state.scope, [flow === "switch" ? "fixture/two" : "fixture/one"]);
					assert.equal(state.thinking, flow === "switch" ? "medium" : "high");
					assert.ok(state.commands.includes(flow === "switch" ? "next_probe" : "work_probe"));
					assert.ok(!state.commands.includes("global_only_probe"));
					if (flow === "switch") assert.ok(!state.commands.includes("work_probe"));
					assert.ok(state.mcp.includes("offline"));
				}
			}
			assert.equal(existsSync(unexpected), false, "no provider calls during recipe restoration");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}
