import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { discoverAgents } from "./agents.ts";
import {
	AIO_EXTENSION_PATH,
	resolveCursorExtensionPath,
} from "./extensions.ts";
import { clearRuns, listRuns, stopRun } from "./registry.ts";
import { buildSpawnSpec, executeSubagentRun } from "./runner.ts";
import type { AgentConfig, ParentLaunchContext } from "./types.ts";

const fixture = join(
	dirname(fileURLToPath(import.meta.url)),
	"test-fixture-child.mjs",
);
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
	const dir = mkdtempSync(join(tmpdir(), "aio-subagents-test-"));
	temporaryDirectories.push(dir);
	return dir;
}

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "reviewer",
		description: "Reviews changes",
		systemPrompt: "Review the assigned change.",
		systemPromptMode: "replace",
		inheritProjectContext: true,
		inheritSkills: false,
		tools: ["read", "grep", "subagent"],
		source: "builtin",
		filePath: "/agents/reviewer.md",
		...overrides,
	};
}

function parent(
	overrides: Partial<ParentLaunchContext> = {},
): ParentLaunchContext {
	return {
		cwd: process.cwd(),
		model: "openai-codex/gpt-parent",
		thinking: "high",
		permissionMode: "auto",
		parentSessionFile: "/tmp/parent.jsonl",
		...overrides,
	};
}

afterEach(() => {
	clearRuns();
	for (const dir of temporaryDirectories.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

test("discovers the neutral builtin agent catalog", () => {
	const names = discoverAgents(process.cwd()).map((entry) => entry.name);
	for (const expected of [
		"planner",
		"researcher",
		"reviewer",
		"scout",
		"validator",
		"worker",
	]) {
		assert.equal(names.includes(expected), true, `missing builtin ${expected}`);
	}
});

test("project agents are excluded when project trust is unavailable", () => {
	const project = temporaryDirectory();
	const agentDir = join(project, ".pi", "agents");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "reviewer.md"),
		`---\nname: reviewer\ndescription: Project override\ntools: read\n---\nProject prompt`,
	);
	assert.equal(
		discoverAgents(project, { includeProject: false }).find(
			(entry) => entry.name === "reviewer",
		)?.source,
		"builtin",
	);
	assert.equal(
		discoverAgents(project, { includeProject: true }).find(
			(entry) => entry.name === "reviewer",
		)?.source,
		"project",
	);
});

test("spawn specification inherits the active parent model and thinking level", () => {
	const runsBaseDir = temporaryDirectory();
	const spec = buildSpawnSpec({
		runId: "run-1",
		index: 0,
		task: { agent: "reviewer", task: "review this" },
		request: { agent: "reviewer", task: "review this" },
		agent: agent(),
		parent: parent({ extensionPaths: [AIO_EXTENSION_PATH] }),
		deps: { runsBaseDir },
	});

	assert.deepEqual(
		spec.args.slice(
			spec.args.indexOf("--model"),
			spec.args.indexOf("--model") + 2,
		),
		["--model", "openai-codex/gpt-parent"],
	);
	assert.deepEqual(
		spec.args.slice(
			spec.args.indexOf("--thinking"),
			spec.args.indexOf("--thinking") + 2,
		),
		["--thinking", "high"],
	);
	assert.deepEqual(
		spec.args.slice(
			spec.args.indexOf("--permission-mode"),
			spec.args.indexOf("--permission-mode") + 2,
		),
		["--permission-mode", "auto"],
	);
	assert.match(spec.args[spec.args.indexOf("--extension") + 1], /index\.ts$/);
	assert.equal(spec.args.includes("--exclude-tools"), true);
	assert.equal(spec.args[spec.args.indexOf("--tools") + 1], "read,grep");
});

test("spawn specification omits extension flags when extension paths are empty", () => {
	const spec = buildSpawnSpec({
		runId: "run-1",
		index: 0,
		task: { agent: "reviewer", task: "review this" },
		request: { agent: "reviewer", task: "review this" },
		agent: agent(),
		parent: parent({ extensionPaths: [] }),
		deps: { runsBaseDir: temporaryDirectory() },
	});
	assert.equal(spec.args.includes("--extension"), false);
	assert.equal(spec.args.includes("--no-extensions"), false);
});

test("explicit task model wins over run, agent, and parent models", () => {
	const spec = buildSpawnSpec({
		runId: "run-2",
		index: 0,
		task: {
			agent: "reviewer",
			task: "review this",
			model: "anthropic/task-model",
		},
		request: { tasks: [], model: "openai/run-model" },
		agent: agent({ model: "google/agent-model" }),
		parent: parent(),
		deps: { runsBaseDir: temporaryDirectory() },
	});
	assert.equal(
		spec.args[spec.args.indexOf("--model") + 1],
		"anthropic/task-model",
	);
});

test("large tasks are passed through a private prompt file", () => {
	const task = "x".repeat(8_001);
	const spec = buildSpawnSpec({
		runId: "run-large",
		index: 0,
		task: { agent: "reviewer", task },
		request: { agent: "reviewer", task },
		agent: agent(),
		parent: parent(),
		deps: { runsBaseDir: temporaryDirectory() },
	});
	const taskArg = spec.args.at(-1);
	assert.ok(taskArg?.startsWith("@"));
	assert.equal(readFileSync(taskArg.slice(1), "utf8"), `Task: ${task}`);
});

test("fork context uses the persisted parent session", () => {
	const root = temporaryDirectory();
	const parentSessionFile = join(root, "parent.jsonl");
	writeFileSync(parentSessionFile, "");
	const spec = buildSpawnSpec({
		runId: "run-3",
		index: 0,
		task: { agent: "reviewer", task: "review this" },
		request: { agent: "reviewer", task: "review this", context: "fork" },
		agent: agent(),
		parent: parent({ parentSessionFile }),
		deps: { runsBaseDir: root },
	});
	assert.equal(spec.args[spec.args.indexOf("--fork") + 1], parentSessionFile);
	assert.equal(spec.requestedSessionFile, undefined);
});

test("parallel execution aggregates child results in task order", async () => {
	const agents = [
		agent(),
		agent({ name: "validator", description: "Validates changes" }),
	];
	const run = await executeSubagentRun({
		request: {
			tasks: [
				{ agent: "reviewer", task: "slow review" },
				{ agent: "validator", task: "fast validation" },
			],
			concurrency: 2,
		},
		agents,
		parent: parent(),
		deps: {
			piBinary: process.execPath,
			piArgsPrefix: [fixture],
			runsBaseDir: temporaryDirectory(),
		},
	});

	assert.equal(run.state, "completed");
	assert.deepEqual(
		run.results.map((result) => result.agent),
		["reviewer", "validator"],
	);
	assert.match(run.results[0].output, /slow review/);
	assert.match(run.results[1].output, /fast validation/);
	assert.equal(run.results[0].model, "openai-codex/gpt-parent");
	assert.equal(run.results[0].usage.cost, 0.01);
});

test("a failed child marks the parallel run failed without discarding successful output", async () => {
	const agents = [
		agent(),
		agent({ name: "validator", description: "Validates changes" }),
	];
	const run = await executeSubagentRun({
		request: {
			tasks: [
				{ agent: "reviewer", task: "successful review" },
				{ agent: "validator", task: "fail validation" },
			],
			concurrency: 2,
		},
		agents,
		parent: parent(),
		deps: {
			piBinary: process.execPath,
			piArgsPrefix: [fixture],
			runsBaseDir: temporaryDirectory(),
		},
	});

	assert.equal(run.state, "failed");
	assert.equal(run.results[0].state, "completed");
	assert.equal(run.results[1].state, "failed");
	assert.match(run.results[1].error ?? "", /fixture failure/);
});

test("abort escalates when a foreground child ignores SIGTERM", async () => {
	const controller = new AbortController();
	const promise = executeSubagentRun({
		request: { agent: "reviewer", task: "ignore-term review" },
		agents: [agent()],
		parent: parent(),
		signal: controller.signal,
		deps: {
			piBinary: process.execPath,
			piArgsPrefix: [fixture],
			runsBaseDir: temporaryDirectory(),
			terminationGraceMs: 20,
		},
	});
	await new Promise((resolve) => setTimeout(resolve, 150));
	controller.abort();
	const run = await promise;
	assert.equal(run.state, "stopped");
	assert.equal(run.results[0].state, "stopped");
});

test("stop terminates an active background-style run", async () => {
	const promise = executeSubagentRun({
		request: { agent: "reviewer", task: "slow review" },
		agents: [agent()],
		parent: parent(),
		deps: {
			piBinary: process.execPath,
			piArgsPrefix: [fixture],
			runsBaseDir: temporaryDirectory(),
		},
	});
	await new Promise((resolve) => setTimeout(resolve, 10));
	const active = listRuns().find((run) => run.state === "running");
	assert.ok(active);
	stopRun(active.id);
	const run = await promise;
	assert.equal(run.state, "stopped");
	assert.equal(run.results[0].state, "stopped");
});

test("cursor parent models include pi-cursor-sdk when it is installed", () => {
	const cursorExtension = resolveCursorExtensionPath();
	if (!cursorExtension) return;
	const spec = buildSpawnSpec({
		runId: "run-cursor",
		index: 0,
		task: { agent: "reviewer", task: "review this" },
		request: { agent: "reviewer", task: "review this" },
		agent: agent(),
		parent: parent({
			model: "cursor/composer-2.5",
			modelProvider: "cursor",
			extensionPaths: [AIO_EXTENSION_PATH, cursorExtension],
		}),
		deps: { runsBaseDir: temporaryDirectory() },
	});
	assert.equal(
		spec.args[spec.args.indexOf("--model") + 1],
		"cursor/composer-2.5",
	);
	assert.equal(spec.args.includes(cursorExtension), true);
});

test("cursor parent models omit --model when pi-cursor-sdk is unavailable", () => {
	const spec = buildSpawnSpec({
		runId: "run-cursor-fallback",
		index: 0,
		task: { agent: "reviewer", task: "review this" },
		request: { agent: "reviewer", task: "review this" },
		agent: agent(),
		parent: parent({
			model: "cursor/composer-2.5",
			modelProvider: "cursor",
			extensionPaths: [AIO_EXTENSION_PATH],
		}),
		deps: { runsBaseDir: temporaryDirectory() },
	});
	assert.equal(spec.args.includes("--model"), false);
});
