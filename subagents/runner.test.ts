import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { discoverAgents } from "./agents.ts";
import {
	AIO_EXTENSION_PATH,
	resolveChildExtensionLaunch,
	resolveCursorExtensionPath,
} from "./extensions.ts";
import { clearRuns, listRuns, stopRun } from "./registry.ts";
import {
	buildSpawnSpec,
	executeSubagentRun,
	formatRunResult,
	childResumeUnavailable,
	resumeSubagentChild,
} from "./runner.ts";
import type { AgentConfig, ParentLaunchContext } from "./types.ts";

const fixture = join(
	dirname(fileURLToPath(import.meta.url)),
	"test-fixture-child.mjs",
);
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
	const base = join(process.cwd(), ".pi-subagents");
	mkdirSync(base, { recursive: true });
	const dir = mkdtempSync(join(base, "runner-test-"));
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
		parent: parent({
			extensionLaunch: { noExtensions: true, paths: [AIO_EXTENSION_PATH] },
		}),
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

test("spawn specification inherits configured packages when the parent did", () => {
	const spec = buildSpawnSpec({
		runId: "run-1",
		index: 0,
		task: { agent: "reviewer", task: "review this" },
		request: { agent: "reviewer", task: "review this" },
		agent: agent(),
		parent: parent({ extensionLaunch: { noExtensions: false, paths: [] } }),
		deps: { runsBaseDir: temporaryDirectory() },
	});
	// No -ne: pi loads the same settings packages (incl. aio) as the parent.
	assert.equal(spec.args.includes("--extension"), false);
	assert.equal(spec.args.includes("--no-extensions"), false);
});

test("a child can never launch bare: -ne always keeps aio loaded", () => {
	const spec = buildSpawnSpec({
		runId: "run-bare",
		index: 0,
		task: { agent: "reviewer", task: "review this" },
		request: { agent: "reviewer", task: "review this" },
		agent: agent(),
		parent: parent({
			extensionLaunch: { noExtensions: true, paths: ["/ext/auth.ts"] },
		}),
		deps: { runsBaseDir: temporaryDirectory() },
	});
	const flags = spec.args.slice(0, spec.args.indexOf("--session"));
	assert.deepEqual(flags.slice(flags.indexOf("--no-extensions")), [
		"--no-extensions",
		"--extension",
		AIO_EXTENSION_PATH,
		"--extension",
		"/ext/auth.ts",
	]);
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

test("agent timeoutMs applies when the request does not set one", async () => {
	const run = await executeSubagentRun({
		request: { agent: "reviewer", task: "ignore-term review" },
		agents: [agent({ timeoutMs: 200 })],
		parent: parent(),
		deps: {
			piBinary: process.execPath,
			piArgsPrefix: [fixture],
			runsBaseDir: temporaryDirectory(),
			terminationGraceMs: 20,
		},
	});
	assert.equal(run.state, "failed");
	assert.equal(run.results[0].state, "failed");
	assert.match(run.results[0].error ?? "", /timed out after 200ms/);
});

test("request timeoutMs overrides the agent's declared timeout", async () => {
	const run = await executeSubagentRun({
		request: {
			agent: "reviewer",
			task: "ignore-term review",
			timeoutMs: 150,
		},
		agents: [agent({ timeoutMs: 5_000 })],
		parent: parent(),
		deps: {
			piBinary: process.execPath,
			piArgsPrefix: [fixture],
			runsBaseDir: temporaryDirectory(),
			terminationGraceMs: 20,
		},
	});
	assert.equal(run.state, "failed");
	assert.equal(run.results[0].state, "failed");
	assert.match(run.results[0].error ?? "", /timed out after 150ms/);
});

function withoutExtraExtensions<T>(fn: () => T): T {
	const saved = process.env.AIO_SUBAGENT_EXTRA_EXTENSIONS;
	delete process.env.AIO_SUBAGENT_EXTRA_EXTENSIONS;
	try {
		return fn();
	} finally {
		if (saved !== undefined)
			process.env.AIO_SUBAGENT_EXTRA_EXTENSIONS = saved;
	}
}

test("child mirrors a -ne parent's explicit extensions (recipe relaunch)", () => {
	const launch = withoutExtraExtensions(() =>
		resolveChildExtensionLaunch({
			modelProvider: "anthropic",
			cwd: "/work",
			argv: [
				"node",
				"pi",
				"-ne",
				"-e",
				AIO_EXTENSION_PATH,
				"-e",
				"/ext/pi-anthropic-auth/src/index.ts",
				"--extension",
				"npm:pi-lens",
				"-e",
				"local/ext.ts",
			],
		}),
	);
	assert.deepEqual(launch, {
		noExtensions: true,
		paths: [
			AIO_EXTENSION_PATH,
			"/ext/pi-anthropic-auth/src/index.ts",
			"npm:pi-lens",
			"/work/local/ext.ts",
		],
	});
});

test("child inherits configured packages when the parent did not pass -ne", () => {
	const launch = withoutExtraExtensions(() =>
		resolveChildExtensionLaunch({
			modelProvider: "anthropic",
			cwd: "/work",
			argv: ["node", "pi", "--model", "anthropic/x"],
		}),
	);
	assert.deepEqual(launch, { noExtensions: false, paths: [] });

	const dev = withoutExtraExtensions(() =>
		resolveChildExtensionLaunch({
			cwd: "/repo",
			argv: ["node", "pi", "-e", "."],
		}),
	);
	assert.deepEqual(dev, { noExtensions: false, paths: ["/repo"] });
});

test("spawn specification omits --no-extensions when inheriting packages", () => {
	const spec = buildSpawnSpec({
		runId: "run-inherit",
		index: 0,
		task: { agent: "reviewer", task: "review this" },
		request: { agent: "reviewer", task: "review this" },
		agent: agent(),
		parent: parent({
			extensionLaunch: { noExtensions: false, paths: ["/repo"] },
		}),
		deps: { runsBaseDir: temporaryDirectory() },
	});
	assert.equal(spec.args.includes("--no-extensions"), false);
	assert.equal(spec.args[spec.args.indexOf("--extension") + 1], "/repo");
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
			extensionLaunch: {
				noExtensions: true,
				paths: [AIO_EXTENSION_PATH, cursorExtension],
			},
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
			extensionLaunch: { noExtensions: true, paths: [AIO_EXTENSION_PATH] },
		}),
		deps: { runsBaseDir: temporaryDirectory() },
	});
	assert.equal(spec.args.includes("--model"), false);
});

test("a child that settles but never exits is reaped and counts as completed", async () => {
	const spawnedArgs: string[][] = [];
	const started = Date.now();
	const run = await executeSubagentRun({
		request: {
			agent: "reviewer",
			task: "linger review",
			// Without settle handling this child would only end via the hard timeout.
			timeoutMs: 2_000,
		},
		agents: [agent()],
		parent: parent(),
		deps: {
			piBinary: process.execPath,
			piArgsPrefix: [fixture],
			runsBaseDir: temporaryDirectory(),
			spawnProcess: recordingSpawn(spawnedArgs),
			settleExitGraceMs: 50,
			terminationGraceMs: 50,
			maxAttempts: 1,
		},
	});
	assert.equal(run.state, "completed");
	assert.equal(run.results[0].state, "completed");
	assert.equal(run.results[0].attempts, 1, "no retry for a finished child");
	assert.equal(spawnedArgs.length, 1);
	assert.equal(run.results[0].reapedAfterSettle, true);
	assert.equal(run.results[0].output, "completed:Task: linger review");
	assert.match(formatRunResult(run), /did not exit on its own/);
	// Well under the 15-minute default timeout the old behavior waited for.
	assert.ok(Date.now() - started < 5_000);
	const activity = run.children[0].activity;
	assert.equal(activity?.toolCount, 1);
	assert.equal(activity?.turns, 1);
	assert.equal(activity?.phase, "finishing");
});

test("a settled child that ignores SIGTERM is SIGKILLed and still completes", async () => {
	const run = await executeSubagentRun({
		request: {
			agent: "reviewer",
			task: "linger-stubborn review",
			timeoutMs: 2_000,
		},
		agents: [agent()],
		parent: parent(),
		deps: {
			piBinary: process.execPath,
			piArgsPrefix: [fixture],
			runsBaseDir: temporaryDirectory(),
			settleExitGraceMs: 30,
			terminationGraceMs: 30,
			maxAttempts: 1,
		},
	});
	assert.equal(run.results[0].state, "completed");
	assert.equal(run.results[0].reapedAfterSettle, true);
});

test("a child that exits on its own after settling is not marked reaped", async () => {
	const run = await executeSubagentRun({
		request: { agent: "reviewer", task: "review this" },
		agents: [agent()],
		parent: parent(),
		deps: {
			piBinary: process.execPath,
			piArgsPrefix: [fixture],
			runsBaseDir: temporaryDirectory(),
			settleExitGraceMs: 5_000,
		},
	});
	assert.equal(run.results[0].state, "completed");
	assert.equal(run.results[0].reapedAfterSettle, false);
	assert.doesNotMatch(formatRunResult(run), /did not exit/);
});

function recordingSpawn(spawnedArgs: string[][]): typeof spawn {
	return ((command: string, args: string[], options: never) => {
		spawnedArgs.push([...args]);
		return spawn(command, args, options);
	}) as unknown as typeof spawn;
}

test("a timed-out child is retried once and resumes its session", async () => {
	const run = await executeSubagentRun({
		request: {
			agent: "reviewer",
			task: "resume-hang review",
			timeoutMs: 250,
		},
		agents: [agent()],
		parent: parent(),
		deps: {
			piBinary: process.execPath,
			piArgsPrefix: [fixture],
			runsBaseDir: temporaryDirectory(),
			terminationGraceMs: 20,
			retryBackoffMs: 10,
		},
	});

	assert.equal(run.state, "completed");
	assert.equal(run.results[0].attempts, 2);
	// The retry continues with a continuation prompt, not the original task.
	assert.match(run.results[0].output ?? "", /previous run was interrupted/);
	assert.doesNotMatch(run.results[0].output ?? "", /Task: resume-hang/);
	// Usage aggregates across both attempts.
	assert.equal(run.results[0].usage.cost, 0.02);
});

test("retry gives up after maxAttempts and preserves the child session", async () => {
	const run = await executeSubagentRun({
		request: {
			agent: "reviewer",
			task: "always-hang review",
			timeoutMs: 200,
		},
		agents: [agent()],
		parent: parent(),
		deps: {
			piBinary: process.execPath,
			piArgsPrefix: [fixture],
			runsBaseDir: temporaryDirectory(),
			terminationGraceMs: 20,
			retryBackoffMs: 10,
		},
	});

	assert.equal(run.state, "failed");
	assert.equal(run.results[0].attempts, 2);
	assert.match(
		run.results[0].error ?? "",
		/timed out after 200ms on attempt 2 of 2/,
	);
	assert.match(run.results[0].error ?? "", /preserved at/);
	assert.ok(run.results[0].sessionFile);
});

test("stopped runs are not retried", async () => {
	const promise = executeSubagentRun({
		request: { agent: "reviewer", task: "resume-hang review" },
		agents: [agent()],
		parent: parent(),
		deps: {
			piBinary: process.execPath,
			piArgsPrefix: [fixture],
			runsBaseDir: temporaryDirectory(),
		},
	});
	await new Promise((resolve) => setTimeout(resolve, 50));
	const active = listRuns().find((run) => run.state === "running");
	assert.ok(active);
	stopRun(active.id);
	const run = await promise;
	assert.equal(run.state, "stopped");
	assert.equal(run.results[0].state, "stopped");
	assert.equal(run.results[0].attempts, 1);
});

test("fork retries resume the forked child session without --fork", async () => {
	const root = temporaryDirectory();
	const parentSessionFile = join(root, "parent.jsonl");
	writeFileSync(parentSessionFile, "");
	const spawnedArgs: string[][] = [];
	const run = await executeSubagentRun({
		request: {
			agent: "reviewer",
			task: "fork-hang review",
			context: "fork",
			timeoutMs: 250,
		},
		agents: [agent()],
		parent: parent({ parentSessionFile }),
		deps: {
			piBinary: process.execPath,
			piArgsPrefix: [fixture],
			runsBaseDir: root,
			terminationGraceMs: 20,
			retryBackoffMs: 10,
			spawnProcess: recordingSpawn(spawnedArgs),
		},
	});

	assert.equal(run.state, "completed");
	assert.equal(run.results[0].attempts, 2);
	assert.match(run.results[0].output ?? "", /previous run was interrupted/);
	const retryArgs = spawnedArgs.at(-1) ?? [];
	assert.equal(retryArgs.includes("--session"), true);
	assert.equal(retryArgs.includes("--fork"), false);
});

test("each parallel child keeps its own live transcript: output, stderr logs, retries", async () => {
	const run = await executeSubagentRun({
		request: {
			tasks: [
				{ agent: "reviewer", task: "linger transcript review" },
				{ agent: "reviewer", task: "fail transcript validation" },
			],
			concurrency: 2,
		},
		agents: [agent()],
		parent: parent(),
		deps: {
			piBinary: process.execPath,
			piArgsPrefix: [fixture],
			runsBaseDir: temporaryDirectory(),
			retryBackoffMs: 0,
			settleExitGraceMs: 20,
		},
	});
	const [ok, failed] = run.children;
	const okKinds = ok?.transcript?.entries.map((entry) => entry.kind) ?? [];
	assert.deepEqual(okKinds, ["notice", "tool", "text", "notice", "notice"]);
	const tool = ok?.transcript?.entries[1];
	assert.equal(tool?.kind === "tool" && tool.summary, "npm test");
	assert.equal(tool?.kind === "tool" && tool.status, "done");

	const texts = (failed?.transcript?.entries ?? []).map((entry) =>
		entry.kind === "tool" ? entry.name : `${entry.kind}:${entry.text}`,
	);
	assert.ok(texts.includes("log:fixture failure\n"));
	assert.ok(texts.some((text) => /^notice:attempt 2\/2/.test(text)));
	assert.match(texts.at(-1) ?? "", /^notice:fixture failure/);
	// The transcript stays in memory: never in the published result text.
	assert.doesNotMatch(formatRunResult(run), /resuming child session|turn 1/);
});

test("manual quota recovery keeps the original configuration and history in a new run", async () => {
	const spawnedArgs: string[][] = [];
	const deps = {
		piBinary: process.execPath,
		piArgsPrefix: [fixture],
		runsBaseDir: temporaryDirectory(),
		spawnProcess: recordingSpawn(spawnedArgs),
		maxAttempts: 1,
	};
	const originalAgent = agent({ thinking: "low", model: "anthropic/original", timeoutMs: 5_000 });
	const originalParent = parent({ extensionLaunch: { noExtensions: true, paths: [AIO_EXTENSION_PATH, "/ext/auth.ts"] } });
	const run = await executeSubagentRun({
		request: { agent: "reviewer", task: "quota-once review" },
		agents: [originalAgent], parent: originalParent, deps,
	});
	const source = run.children[0];
	assert.equal(run.state, "failed");
	assert.equal(source.thinking, "low");
	assert.equal(childResumeUnavailable(run, source), undefined);
	const oldEntries = structuredClone(source.transcript?.entries);
	const oldResult = structuredClone(run.results[0]);
	// Changes to parent/agent settings must not affect a resumed child.
	originalAgent.thinking = "max";
	originalAgent.model = "other/model";
	originalAgent.systemPrompt = "Changed prompt";
	originalParent.cwd = "/missing";
	originalParent.extensionLaunch!.paths.length = 0;
	const promise = resumeSubagentChild({ run, child: source, deps });
	await assert.rejects(resumeSubagentChild({ run, child: source, deps }), /Already resumed/);
	const resumed = await promise;
	assert.equal(resumed.state, "completed");
	assert.notEqual(resumed.id, run.id);
	assert.deepEqual(resumed.resumedFrom, { runId: run.id, index: 0 });
	assert.equal(resumed.results[0].sessionFile, source.sessionFile);
	assert.equal(resumed.results[0].thinking, "low");
	assert.equal(resumed.results[0].usage.cost, 0.01, "do not count the old attempt twice");
	assert.match(resumed.results[0].output, /previous run was interrupted/);
	assert.deepEqual(run.results[0], oldResult);
	assert.deepEqual(source.transcript?.entries, oldEntries);
	assert.notEqual(resumed.children[0].transcript, source.transcript);
	assert.deepEqual(resumed.children[0].transcript?.entries.slice(0, oldEntries!.length), oldEntries);
	const args = spawnedArgs.at(-1)!;
	assert.equal(args[args.indexOf("--session") + 1], source.sessionFile);
	assert.equal(args[args.indexOf("--model") + 1], "anthropic/original");
	assert.equal(args[args.indexOf("--thinking") + 1], "low");
	assert.ok(args.includes("/ext/auth.ts"));
	assert.equal(args.includes("--fork"), false);
	assert.match(readFileSync(args[args.indexOf("--system-prompt") + 1], "utf8"), /Review the assigned change/);
	assert.match(formatRunResult(resumed), new RegExp(`Resumed child #1 from run ${run.id}`));
});

test("manual recovery resumes a forked child's exact session, not the parent", async () => {
	const spawnedArgs: string[][] = [];
	const deps = { piBinary: process.execPath, piArgsPrefix: [fixture], runsBaseDir: temporaryDirectory(), maxAttempts: 1, spawnProcess: recordingSpawn(spawnedArgs) };
	const run = await executeSubagentRun({
		request: { agent: "reviewer", task: "quota-once review", context: "fork" },
		agents: [agent()], parent: parent(), deps,
	});
	const resumed = await resumeSubagentChild({ run, child: run.children[0], deps });
	assert.equal(resumed.state, "completed");
	assert.equal(resumed.results[0].sessionFile, run.results[0].sessionFile);
	assert.match(resumed.results[0].sessionFile!, /forked-child.jsonl$/);
	assert.equal(spawnedArgs[1].includes("--fork"), false);
});

test("fork recovery retains the explicit child assignment when only parent history was saved", async () => {
	const spawnedArgs: string[][] = [];
	const deps = { piBinary: process.execPath, piArgsPrefix: [fixture], runsBaseDir: temporaryDirectory(), maxAttempts: 1, spawnProcess: recordingSpawn(spawnedArgs) };
	const task = "fork-parent-only inspect the security changes, not the parent task";
	const run = await executeSubagentRun({ request: { agent: "reviewer", task, context: "fork" }, agents: [agent()], parent: parent(), deps });
	assert.equal(run.state, "failed");
	assert.doesNotMatch(readFileSync(run.children[0].sessionFile!, "utf8"), /inspect the security/);
	const resumed = await resumeSubagentChild({ run, child: run.children[0], deps });
	assert.equal(resumed.state, "completed");
	const prompt = spawnedArgs.at(-1)!.at(-1)!;
	assert.match(prompt, /without redoing work already completed/);
	assert.ok(prompt.includes(task));
	assert.match(prompt, /Assigned child task \(not the parent's task\)/);
});

test("large continuation prompts use a private file instead of an oversized argv", () => {
	const prompt = "continuation ".repeat(1_000);
	const spec = buildSpawnSpec({
		runId: "large-resume", index: 0,
		task: { agent: "reviewer", task: "original task" }, request: {},
		agent: agent(), parent: parent(), deps: { runsBaseDir: temporaryDirectory() },
		resumeSessionFile: "/saved/session.jsonl", promptOverride: prompt,
	});
	const arg = spec.args.at(-1)!;
	assert.ok(arg.startsWith("@"));
	assert.equal(readFileSync(arg.slice(1), "utf8"), prompt);
});

test("a failed continuation can resume again, but its ancestors cannot", async () => {
	const deps = { piBinary: process.execPath, piArgsPrefix: [fixture], runsBaseDir: temporaryDirectory(), maxAttempts: 1 };
	const run = await executeSubagentRun({ request: { agent: "reviewer", task: "quota-always review" }, agents: [agent()], parent: parent(), deps });
	const next = await resumeSubagentChild({ run, child: run.children[0], deps: { ...deps, maxAttempts: 2, retryBackoffMs: 0 } });
	assert.equal(next.state, "failed");
	assert.equal(next.results[0].attempts, 2);
	assert.equal(next.results[0].sessionFile, run.results[0].sessionFile);
	assert.equal(childResumeUnavailable(next, next.children[0]), undefined);
	assert.match(childResumeUnavailable(run, run.children[0])!, /Already resumed/);
	const third = await resumeSubagentChild({ run: next, child: next.children[0], deps });
	assert.equal(third.state, "failed");
	assert.equal(third.results[0].sessionFile, run.results[0].sessionFile);
});

test("a recovery launch failure retains the saved session for another resume", async () => {
	const deps = { piBinary: process.execPath, piArgsPrefix: [fixture], runsBaseDir: temporaryDirectory(), maxAttempts: 1 };
	const run = await executeSubagentRun({ request: { agent: "reviewer", task: "quota-once review" }, agents: [agent()], parent: parent(), deps });
	const blockedDir = join(deps.runsBaseDir, "not-a-directory");
	writeFileSync(blockedDir, "blocked");
	const failed = await resumeSubagentChild({ run, child: run.children[0], deps: { ...deps, runsBaseDir: blockedDir } });
	assert.equal(failed.state, "failed");
	assert.equal(failed.results[0].sessionFile, run.results[0].sessionFile);
	assert.equal(childResumeUnavailable(failed, failed.children[0]), undefined);
	const recovered = await resumeSubagentChild({ run: failed, child: failed.children[0], deps });
	assert.equal(recovered.state, "completed");
});

test("recovery refuses missing sessions and old-session runs without spawning", async () => {
	const spawnedArgs: string[][] = [];
	const deps = { piBinary: process.execPath, piArgsPrefix: [fixture], runsBaseDir: temporaryDirectory(), maxAttempts: 1, spawnProcess: recordingSpawn(spawnedArgs) };
	const run = await executeSubagentRun({ request: { agent: "reviewer", task: "quota-once review" }, agents: [agent()], parent: parent(), deps });
	rmSync(run.children[0].sessionFile!);
	await assert.rejects(resumeSubagentChild({ run, child: run.children[0], deps }), /No saved child session/);
	assert.equal(spawnedArgs.length, 1);
	clearRuns();
	await assert.rejects(resumeSubagentChild({ run, child: run.children[0], deps }), /no longer in the current session/);
});

test("stopped children wait for process cleanup, then can resume without retrying siblings", async () => {
	const deps = { piBinary: process.execPath, piArgsPrefix: [fixture], runsBaseDir: temporaryDirectory(), maxAttempts: 1 };
	let stopped = false;
	const run = await executeSubagentRun({
		request: { tasks: [{ agent: "reviewer", task: "resume-hang review" }, { agent: "reviewer", task: "other completed task" }], concurrency: 1 },
		agents: [agent()], parent: parent(), deps,
		onUpdate: (active) => {
			if (!stopped && active.children[0].output) {
				stopped = true;
				stopRun(active.id);
				assert.match(childResumeUnavailable(active, active.children[0])!, /still stopping/);
			}
		},
	});
	assert.equal(run.state, "stopped");
	assert.equal(childResumeUnavailable(run, run.children[0]), undefined);
	assert.match(childResumeUnavailable(run, run.children[1])!, /still stopping|No saved/);
	const resumed = await resumeSubagentChild({ run, child: run.children[0], deps });
	assert.equal(resumed.state, "completed");
	assert.equal(resumed.children.length, 1);
	assert.equal(run.children[1].state, "stopped");
	await assert.rejects(resumeSubagentChild({ run: resumed, child: resumed.children[0], deps }), /Only failed or stopped/);
});
