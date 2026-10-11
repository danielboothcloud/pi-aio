import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { findAgent } from "./agents.js";
import {
	childSupportsModel,
	resolveChildExtensionPaths,
} from "./extensions.js";
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
const DEFAULT_MAX_ATTEMPTS = 2;
const MAX_ATTEMPTS_CAP = 5;
const DEFAULT_RETRY_BACKOFF_MS = 1_000;
// Prompt sent to the CHILD agent (not the orchestrator) on a retry attempt:
// it replaces the original task argument, which already lives in the resumed
// child session history.
const CONTINUATION_PROMPT =
	"Your previous run was interrupted before you could finish (provider request stall or hard timeout). Continue the original task from this session's history without redoing work already completed, then return the final result.";
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
	/** Total attempts per child (default 2: one automatic retry). */
	maxAttempts?: number;
	/** Delay before a retry attempt (default 1s). */
	retryBackoffMs?: number;
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
	const model = task.model ?? request.model ?? agent.model ?? parent.model;
	if (!model) return undefined;
	const extensionPaths =
		parent.extensionPaths ??
		resolveChildExtensionPaths({ modelProvider: parent.modelProvider });
	return childSupportsModel(extensionPaths, model) ? model : undefined;
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
	/** Resume an existing child session instead of forking or starting fresh. */
	resumeSessionFile?: string;
	/** Replacement prompt for retries (the task already lives in the resumed session). */
	promptOverride?: string;
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
	const extensionPaths =
		input.parent.extensionPaths ??
		resolveChildExtensionPaths({ modelProvider: input.parent.modelProvider });
	if (extensionPaths.length) {
		args.push("--no-extensions");
		for (const extensionPath of extensionPaths) {
			args.push("--extension", extensionPath);
		}
	}
	const context = input.request.context ?? "fresh";
	let requestedSessionFile: string | undefined;
	if (input.resumeSessionFile) {
		// --fork cannot be combined with --session; resuming the forked child's
		// own session preserves its progress without re-forking from the parent.
		args.push("--session", input.resumeSessionFile);
	} else if (context === "fork") {
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
	if (input.promptOverride !== undefined) {
		// Retry prompt for the child process (positional argument); the parent
		// never sees this text.
		args.push(input.promptOverride);
	} else if (input.task.task.length > TASK_ARG_LIMIT) {
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

interface AttemptOutcome {
	code: number;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	stderr: string;
	parsed: ParsedChildOutput;
	sessionFile?: string;
}

function attemptFailed(outcome: AttemptOutcome): boolean {
	return (
		outcome.timedOut ||
		outcome.parsed.assistantError !== undefined ||
		outcome.code !== 0
	);
}

function sessionHasUserTurn(sessionFile: string): boolean {
	try {
		return readFileSync(sessionFile, "utf8").includes('"role":"user"');
	} catch {
		return false;
	}
}

function preservedSessionNote(outcome: AttemptOutcome): string {
	return outcome.sessionFile
		? ` Child session preserved at ${outcome.sessionFile}.`
		: "";
}

function describedFailure(input: {
	outcome: AttemptOutcome;
	timeoutMs: number;
	attempts: number;
	maxAttempts: number;
}): string {
	const { outcome } = input;
	if (outcome.timedOut) {
		return `Subagent timed out after ${input.timeoutMs}ms on attempt ${input.attempts} of ${input.maxAttempts}.${preservedSessionNote(outcome)}`;
	}
	const suffix = ` (attempt ${input.attempts} of ${input.maxAttempts})`;
	const preserved = preservedSessionNote(outcome);
	if (outcome.parsed.assistantError)
		return `${outcome.parsed.assistantError}${suffix}.${preserved}`;
	const base =
		outcome.stderr.trim() ||
		`Subagent exited with code ${outcome.code}${outcome.signal ? ` (${outcome.signal})` : ""}`;
	return `${base}${suffix}.${preserved}`;
}

function composedChildState(input: {
	specError?: string;
	outcome?: AttemptOutcome;
	wasStopped: boolean;
	timeoutMs: number;
	attempts: number;
	maxAttempts: number;
}): { state: ChildRunResult["state"]; error?: string } {
	if (input.specError !== undefined)
		return { state: "failed", error: input.specError };
	if (!input.outcome)
		return { state: "failed", error: "Subagent child did not run." };
	if (input.wasStopped) return { state: "stopped" };
	if (attemptFailed(input.outcome)) {
		return {
			state: "failed",
			error: describedFailure({
				outcome: input.outcome,
				timeoutMs: input.timeoutMs,
				attempts: input.attempts,
				maxAttempts: input.maxAttempts,
			}),
		};
	}
	return { state: "completed" };
}

function nextRetryInputs(outcome: AttemptOutcome): {
	resumeSessionFile?: string;
	promptOverride?: string;
} {
	if (!outcome.sessionFile) return {};
	const resumeSessionFile = outcome.sessionFile;
	return {
		resumeSessionFile,
		promptOverride: sessionHasUserTurn(resumeSessionFile)
			? CONTINUATION_PROMPT
			: undefined,
	};
}

function accumulateUsage(total: ChildUsage, delta: ChildUsage): void {
	total.input += delta.input;
	total.output += delta.output;
	total.cacheRead += delta.cacheRead;
	total.cacheWrite += delta.cacheWrite;
	total.cost += delta.cost;
}

async function runChildAttempt(input: {
	run: SubagentRun;
	status: ChildRunStatus;
	spec: SpawnSpec;
	timeoutMs: number;
	terminationGraceMs: number;
	signal?: AbortSignal;
	onUpdate?: (run: SubagentRun) => void;
	deps?: RunnerDeps;
}): Promise<AttemptOutcome> {
	const parsed: ParsedChildOutput = { finalOutput: "", usage: emptyUsage() };
	let stderr = "";
	let timedOut = false;
	let abortListener: (() => void) | undefined;
	let abortKillTimer: NodeJS.Timeout | undefined;
	const spawnProcess = input.deps?.spawnProcess ?? spawn;
	// SAFETY: stdio tuple [null, Readable, Readable] guarantees stdout/stderr are
	// non-null Readables; only stdin differs from ChildProcessWithoutNullStreams.
	const process = spawnProcess(input.spec.command, input.spec.args, {
		cwd: input.spec.cwd,
		env: input.spec.env,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	}) as unknown as ChildProcessWithoutNullStreams;
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

	const timeout = setTimeout(() => {
		timedOut = true;
		process.kill("SIGTERM");
		const killTimer = setTimeout(() => {
			if (process.exitCode === null && process.signalCode === null)
				process.kill("SIGKILL");
		}, input.terminationGraceMs);
		killTimer.unref?.();
	}, input.timeoutMs);
	timeout.unref?.();

	if (input.signal) {
		abortListener = () => {
			process.kill("SIGTERM");
			abortKillTimer = setTimeout(() => {
				if (process.exitCode === null && process.signalCode === null)
					process.kill("SIGKILL");
			}, input.terminationGraceMs);
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

	const sessionFile = findSessionFile(
		input.spec.sessionDir,
		input.spec.requestedSessionFile,
	);
	return {
		code,
		signal,
		timedOut,
		stderr,
		parsed,
		sessionFile,
	};
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
	input.status.attempts = 0;
	input.onUpdate?.(input.run);

	const maxAttempts = Math.max(
		1,
		Math.min(
			input.deps?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
			MAX_ATTEMPTS_CAP,
		),
	);
	const retryBackoffMs =
		input.deps?.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
	const timeoutMs =
		input.request.timeoutMs ?? input.agent.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const terminationGraceMs =
		input.deps?.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;

	let resumeSessionFile: string | undefined;
	let promptOverride: string | undefined;
	let outcome: AttemptOutcome | undefined;
	let specError: string | undefined;
	let attempts = 0;
	const totalUsage = emptyUsage();
	let lastOutput = "";
	let lastModel: string | undefined;

	while (attempts < maxAttempts) {
		attempts++;
		input.status.attempts = attempts;
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
				resumeSessionFile,
				promptOverride,
			});
		} catch (error) {
			specError = error instanceof Error ? error.message : String(error);
			break;
		}

		outcome = await runChildAttempt({
			run: input.run,
			status: input.status,
			spec,
			timeoutMs,
			terminationGraceMs,
			signal: input.signal,
			onUpdate: input.onUpdate,
			deps: input.deps,
		});
		accumulateUsage(totalUsage, outcome.parsed.usage);
		if (outcome.parsed.finalOutput) lastOutput = outcome.parsed.finalOutput;
		if (outcome.parsed.model) lastModel = outcome.parsed.model;

		const wasStopped =
			input.run.stopRequested || input.signal?.aborted === true;
		if (wasStopped || !attemptFailed(outcome) || attempts >= maxAttempts)
			break;

		// Resume the child's preserved session so completed turns survive the
		// failed attempt instead of being discarded.
		({ resumeSessionFile, promptOverride } = nextRetryInputs(outcome));
		if (retryBackoffMs > 0)
			await new Promise((resolve) => setTimeout(resolve, retryBackoffMs));
		if (input.run.stopRequested || input.signal?.aborted) break;
	}

	const endedAt = Date.now();
	const wasStopped = input.run.stopRequested || input.signal?.aborted === true;
	const { state, error } = composedChildState({
		specError,
		outcome,
		wasStopped,
		timeoutMs,
		attempts,
		maxAttempts,
	});

	const sessionFile = outcome?.sessionFile;
	let output = lastOutput;
	if (!output && !error)
		output = "(Subagent completed without a textual result.)";
	Object.assign(input.status, {
		state,
		output,
		error,
		endedAt,
		sessionFile,
		attempts,
		model: lastModel ?? input.status.model,
	});
	input.onUpdate?.(input.run);
	return {
		index: input.status.index,
		agent: input.agent.name,
		task: input.task.task,
		state,
		output,
		error,
		exitCode: state === "completed" ? 0 : outcome?.code || 1,
		model: lastModel ?? input.status.model,
		sessionFile,
		startedAt,
		endedAt,
		usage: totalUsage,
		attempts,
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
		const attemptsNote = result.attempts > 1 ? ` (${result.attempts} attempts)` : "";
		const title = `=== ${result.agent} [${result.state}]${attemptsNote} ===`;
		let body = result.output;
		if (result.error)
			body = result.output
				? `${result.error}\n\n${result.output}`
				: result.error;
		return `${title}\n${body}`;
	});
	return [header, ...results].join("\n\n");
}
