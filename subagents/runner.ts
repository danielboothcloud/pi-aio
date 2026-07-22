import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { findAgent } from "./agents.js";
import { createRun } from "./registry.js";
import type {
	AgentConfig,
	ChildRunResult,
	ChildRunStatus,
	ChildUsage,
	ParentLaunchContext,
	SpawnSpec,
	SubagentRun,
	SubagentRunRequest,
	SubagentTask,
	SubagentThinking,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_TERMINATION_GRACE_MS = 3_000;
const DEFAULT_CONCURRENCY = 4;
const MAX_TASKS = 12;
const TASK_ARG_LIMIT = 8_000;
const MAX_OUTPUT_CHARS = 50_000;
const MAX_STDERR_CHARS = 50_000;
const ANSI_PATTERN =
	/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export interface RunnerDeps {
	spawnProcess?: typeof spawn;
	piBinary?: string;
	piArgsPrefix?: string[];
	runsBaseDir?: string;
	terminationGraceMs?: number;
}

interface RunInput {
	request: SubagentRunRequest;
	agents: AgentConfig[];
	parent: ParentLaunchContext;
	signal?: AbortSignal;
	onUpdate?: (run: SubagentRun) => void;
	deps?: RunnerDeps;
}

interface ParsedChildOutput {
	finalOutput: string;
	model?: string;
	usage: ChildUsage;
	assistantError?: string;
}

function emptyUsage(): ChildUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => {
			if (typeof part !== "object" || part === null) return [];
			const block = part as { type?: unknown; text?: unknown };
			return block.type === "text" && typeof block.text === "string"
				? [block.text]
				: [];
		})
		.join("\n");
}

function parseEventLine(line: string, parsed: ParsedChildOutput): void {
	const clean = line.replace(ANSI_PATTERN, "").trim();
	const objectStart = clean.indexOf("{");
	if (objectStart === -1) return;
	let event: Record<string, unknown>;
	try {
		event = JSON.parse(clean.slice(objectStart)) as Record<string, unknown>;
	} catch {
		return;
	}
	if (
		event.type !== "message_end" ||
		typeof event.message !== "object" ||
		event.message === null
	)
		return;
	const message = event.message as Record<string, unknown>;
	if (message.role !== "assistant") return;
	const text = textFromContent(message.content).trim();
	if (text) {
		parsed.finalOutput =
			text.length > MAX_OUTPUT_CHARS
				? `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n[Subagent output truncated at ${MAX_OUTPUT_CHARS} characters]`
				: text;
	}
	if (typeof message.model === "string") parsed.model = message.model;
	if (typeof message.errorMessage === "string")
		parsed.assistantError = message.errorMessage;
	if (typeof message.usage !== "object" || message.usage === null) return;
	const usage = message.usage as Record<string, unknown>;
	parsed.usage.input += Number(usage.input) || 0;
	parsed.usage.output += Number(usage.output) || 0;
	parsed.usage.cacheRead += Number(usage.cacheRead) || 0;
	parsed.usage.cacheWrite += Number(usage.cacheWrite) || 0;
	if (typeof usage.cost === "object" && usage.cost !== null) {
		parsed.usage.cost +=
			Number((usage.cost as Record<string, unknown>).total) || 0;
	}
}

function resolveRunsBaseDir(deps?: RunnerDeps): string {
	if (deps?.runsBaseDir) return deps.runsBaseDir;
	try {
		return join(getAgentDir(), "aio", "subagents", "runs");
	} catch {
		return join(process.cwd(), ".aio-subagents", "runs");
	}
}

function resolvedModel(
	task: SubagentTask,
	request: SubagentRunRequest,
	agent: AgentConfig,
	parent: ParentLaunchContext,
): string | undefined {
	return task.model ?? request.model ?? agent.model ?? parent.model;
}

function resolvedThinking(
	task: SubagentTask,
	request: SubagentRunRequest,
	agent: AgentConfig,
	parent: ParentLaunchContext,
): SubagentThinking | undefined {
	return task.thinking ?? request.thinking ?? agent.thinking ?? parent.thinking;
}

function childSystemPrompt(agent: AgentConfig): string {
	return `[CHILD AGENT BOUNDARY]\nYou are a focused child agent working for a parent Pi session. Complete only the assigned task. Do not launch or propose additional subagents. Return a concise, evidence-backed result to the parent. Follow the tool and repository constraints supplied to this child.\n\n${agent.systemPrompt}`;
}

function findSessionFile(
	sessionDir: string,
	requested?: string,
): string | undefined {
	if (requested && existsSync(requested)) return requested;
	if (!existsSync(sessionDir)) return undefined;
	return readdirSync(sessionDir)
		.filter((name) => name.endsWith(".jsonl"))
		.sort((a, b) => a.localeCompare(b))
		.map((name) => join(sessionDir, name))
		.at(-1);
}

export function buildSpawnSpec(input: {
	runId: string;
	index: number;
	task: SubagentTask;
	request: SubagentRunRequest;
	agent: AgentConfig;
	parent: ParentLaunchContext;
	deps?: RunnerDeps;
}): SpawnSpec {
	const childDir = join(
		resolveRunsBaseDir(input.deps),
		input.runId,
		`child-${input.index}`,
	);
	mkdirSync(childDir, { recursive: true });
	const promptPath = join(childDir, "system-prompt.md");
	writeFileSync(promptPath, childSystemPrompt(input.agent), {
		encoding: "utf8",
		mode: 0o600,
	});

	const args = [...(input.deps?.piArgsPrefix ?? []), "--mode", "json", "-p"];
	if (input.parent.extensionPath) {
		args.push("--no-extensions", "--extension", input.parent.extensionPath);
	}
	const context = input.request.context ?? "fresh";
	let requestedSessionFile: string | undefined;
	if (context === "fork") {
		if (!input.parent.parentSessionFile) {
			throw new Error(
				"Forked subagents require a persisted parent session file.",
			);
		}
		args.push(
			"--fork",
			input.parent.parentSessionFile,
			"--session-dir",
			childDir,
		);
	} else {
		requestedSessionFile = join(childDir, "session.jsonl");
		args.push("--session", requestedSessionFile);
	}

	const model = resolvedModel(
		input.task,
		input.request,
		input.agent,
		input.parent,
	);
	if (model) args.push("--model", model);
	const thinking = resolvedThinking(
		input.task,
		input.request,
		input.agent,
		input.parent,
	);
	if (thinking) args.push("--thinking", thinking);
	args.push("--permission-mode", input.parent.permissionMode);
	args.push(
		input.agent.systemPromptMode === "append"
			? "--append-system-prompt"
			: "--system-prompt",
		promptPath,
	);
	if (!input.agent.inheritProjectContext) args.push("--no-context-files");
	if (!input.agent.inheritSkills) args.push("--no-skills");
	const tools = input.agent.tools?.filter((tool) => tool !== "subagent");
	if (tools?.length) args.push("--tools", tools.join(","));
	args.push("--exclude-tools", "subagent");
	if (input.task.task.length > TASK_ARG_LIMIT) {
		const taskPath = join(childDir, "task.md");
		writeFileSync(taskPath, `Task: ${input.task.task}`, {
			encoding: "utf8",
			mode: 0o600,
		});
		args.push(`@${taskPath}`);
	} else {
		args.push(`Task: ${input.task.task}`);
	}

	return {
		command:
			input.deps?.piBinary ??
			(process.env.AIO_SUBAGENT_PI_BINARY?.trim() || "pi"),
		args,
		cwd: input.parent.cwd,
		env: {
			...process.env,
			AIO_SUBAGENT_CHILD: "1",
			AIO_SUBAGENT_RUN_ID: input.runId,
			AIO_SUBAGENT_AGENT: input.agent.name,
		},
		sessionDir: childDir,
		requestedSessionFile,
	};
}

function normalizeTasks(request: SubagentRunRequest): SubagentTask[] {
	const hasSingle = request.agent !== undefined || request.task !== undefined;
	const hasParallel = request.tasks !== undefined;
	if (hasSingle === hasParallel) {
		throw new Error(
			"Provide either 'agent' and 'task' for a single run, or 'tasks' for a parallel run.",
		);
	}
	if (hasSingle) {
		if (!request.agent?.trim() || !request.task?.trim())
			throw new Error(
				"Single runs require non-empty 'agent' and 'task' values.",
			);
		return [{ agent: request.agent, task: request.task }];
	}
	if (!request.tasks?.length)
		throw new Error("Parallel runs require at least one task.");
	if (request.tasks.length > MAX_TASKS)
		throw new Error(`Parallel runs support at most ${MAX_TASKS} tasks.`);
	for (const task of request.tasks) {
		if (!task.agent?.trim() || !task.task?.trim())
			throw new Error(
				"Every parallel task requires non-empty 'agent' and 'task' values.",
			);
	}
	return request.tasks;
}

async function runChild(input: {
	run: SubagentRun;
	status: ChildRunStatus;
	task: SubagentTask;
	request: SubagentRunRequest;
	agent: AgentConfig;
	parent: ParentLaunchContext;
	signal?: AbortSignal;
	onUpdate?: (run: SubagentRun) => void;
	deps?: RunnerDeps;
}): Promise<ChildRunResult> {
	const startedAt = Date.now();
	input.status.state = "running";
	input.status.startedAt = startedAt;
	input.status.model = resolvedModel(
		input.task,
		input.request,
		input.agent,
		input.parent,
	);
	input.onUpdate?.(input.run);

	let spec: SpawnSpec;
	try {
		spec = buildSpawnSpec({
			runId: input.run.id,
			index: input.status.index,
			task: input.task,
			request: input.request,
			agent: input.agent,
			parent: input.parent,
			deps: input.deps,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		input.status.state = "failed";
		input.status.error = message;
		input.status.endedAt = Date.now();
		return {
			index: input.status.index,
			agent: input.agent.name,
			task: input.task.task,
			state: "failed",
			output: "",
			error: message,
			exitCode: 1,
			model: input.status.model,
			startedAt,
			endedAt: input.status.endedAt,
			usage: emptyUsage(),
		};
	}

	const parsed: ParsedChildOutput = { finalOutput: "", usage: emptyUsage() };
	let stderr = "";
	let timedOut = false;
	let abortListener: (() => void) | undefined;
	let abortKillTimer: NodeJS.Timeout | undefined;
	const spawnProcess = input.deps?.spawnProcess ?? spawn;
	const process = spawnProcess(spec.command, spec.args, {
		cwd: spec.cwd,
		env: spec.env,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	}) as ChildProcessWithoutNullStreams;
	input.status.process = process;

	const stdoutLines = createInterface({ input: process.stdout });
	stdoutLines.on("line", (line) => {
		parseEventLine(line, parsed);
		if (parsed.finalOutput) input.status.output = parsed.finalOutput;
		input.onUpdate?.(input.run);
	});
	process.stderr.on("data", (chunk: Buffer | string) => {
		stderr = `${stderr}${chunk.toString()}`.slice(-MAX_STDERR_CHARS);
	});

	const timeoutMs = input.request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const terminationGraceMs =
		input.deps?.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
	const timeout = setTimeout(() => {
		timedOut = true;
		process.kill("SIGTERM");
		const killTimer = setTimeout(() => {
			if (process.exitCode === null && process.signalCode === null)
				process.kill("SIGKILL");
		}, terminationGraceMs);
		killTimer.unref?.();
	}, timeoutMs);
	timeout.unref?.();

	if (input.signal) {
		abortListener = () => {
			process.kill("SIGTERM");
			abortKillTimer = setTimeout(() => {
				if (process.exitCode === null && process.signalCode === null)
					process.kill("SIGKILL");
			}, terminationGraceMs);
			abortKillTimer.unref?.();
		};
		if (input.signal.aborted) abortListener();
		else input.signal.addEventListener("abort", abortListener, { once: true });
	}

	const { code, signal } = await new Promise<{
		code: number;
		signal: NodeJS.Signals | null;
	}>((resolve) => {
		process.once("error", (error) => {
			stderr = `${stderr}\n${error.message}`.trim();
			resolve({ code: 1, signal: null });
		});
		process.once("close", (code, signal) =>
			resolve({ code: code ?? 1, signal }),
		);
	});
	clearTimeout(timeout);
	if (abortKillTimer) clearTimeout(abortKillTimer);
	if (abortListener && input.signal)
		input.signal.removeEventListener("abort", abortListener);
	stdoutLines.close();
	input.status.process = undefined;

	const endedAt = Date.now();
	const wasStopped = input.run.stopRequested || input.signal?.aborted === true;
	let error: string | undefined;
	if (timedOut) error = `Subagent timed out after ${timeoutMs}ms.`;
	else if (parsed.assistantError) error = parsed.assistantError;
	else if (code !== 0 && !wasStopped)
		error =
			stderr.trim() ||
			`Subagent exited with code ${code}${signal ? ` (${signal})` : ""}.`;

	let state: ChildRunResult["state"] = "completed";
	if (wasStopped) state = "stopped";
	else if (error) state = "failed";
	const sessionFile = findSessionFile(
		spec.sessionDir,
		spec.requestedSessionFile,
	);
	let output = parsed.finalOutput;
	if (!output && !error)
		output = "(Subagent completed without a textual result.)";
	Object.assign(input.status, {
		state,
		output,
		error,
		endedAt,
		sessionFile,
		model: parsed.model ?? input.status.model,
	});
	input.onUpdate?.(input.run);
	return {
		index: input.status.index,
		agent: input.agent.name,
		task: input.task.task,
		state,
		output,
		error,
		exitCode: state === "completed" ? 0 : code || 1,
		model: parsed.model ?? input.status.model,
		sessionFile,
		startedAt,
		endedAt,
		usage: parsed.usage,
	};
}

export async function executeSubagentRun(
	input: RunInput,
): Promise<SubagentRun> {
	const tasks = normalizeTasks(input.request);
	const resolvedAgents = tasks.map((task) =>
		findAgent(input.agents, task.agent),
	);
	const context = input.request.context ?? "fresh";
	const children: ChildRunStatus[] = tasks.map((task, index) => ({
		index,
		agent: task.agent,
		task: task.task,
		state: "queued",
	}));
	const mode = tasks.length === 1 ? "single" : "parallel";
	const run = createRun({ mode, context, cwd: input.parent.cwd, children });
	run.state = "running";
	input.onUpdate?.(run);

	const concurrency = Math.max(
		1,
		Math.min(input.request.concurrency ?? DEFAULT_CONCURRENCY, tasks.length),
	);
	let nextIndex = 0;
	const workers = Array.from({ length: concurrency }, async () => {
		while (!run.stopRequested) {
			const index = nextIndex++;
			if (index >= tasks.length) return undefined;
			const task = tasks[index];
			const result = await runChild({
				run,
				status: children[index],
				task,
				request: input.request,
				agent: resolvedAgents[index],
				parent: input.parent,
				signal: input.signal,
				onUpdate: input.onUpdate,
				deps: input.deps,
			});
			run.results[index] = result;
		}
		return undefined;
	});
	await Promise.all(workers);

	for (const child of children) {
		if (child.state === "queued") child.state = "stopped";
	}
	run.endedAt = Date.now();
	if (run.stopRequested || input.signal?.aborted) run.state = "stopped";
	else if (run.results.some((result) => result.state === "failed")) {
		run.state = "failed";
		run.error = `${run.results.filter((result) => result.state === "failed").length} subagent task(s) failed.`;
	} else run.state = "completed";
	input.onUpdate?.(run);
	return run;
}

export function formatRunResult(run: SubagentRun): string {
	const header = `Subagent run ${run.id} ${run.state} (${run.mode}, ${run.context} context).`;
	const results = run.results.map((result) => {
		const title = `=== ${result.agent} [${result.state}] ===`;
		let body = result.output;
		if (result.error)
			body = result.output
				? `${result.error}\n\n${result.output}`
				: result.error;
		return `${title}\n${body}`;
	});
	return [header, ...results].join("\n\n");
}
