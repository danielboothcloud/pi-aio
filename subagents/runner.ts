import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	applyActivityEvent,
	createActivity,
	resetActivityForAttempt,
} from "./activity.js";
import { findAgent } from "./agents.js";
import {
	appendTranscriptLog,
	applyTranscriptEvent,
	createTranscript,
	pushTranscriptNotice,
	type ChildTranscript,
} from "./transcript.js";
import {
	type ChildExtensionLaunch,
	childSupportsModel,
	enforceChildExtensions,
	resolveChildExtensionLaunch,
} from "./extensions.js";
import { createRun, getRun } from "./registry.js";
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
// `pi -p` only exits once its event loop drains; an extension that leaves a
// live handle in the headless child would otherwise hang the parent until
// the hard timeout. After agent_settled, allow this long for a natural exit.
const DEFAULT_SETTLE_EXIT_GRACE_MS = 10_000;
// Streaming deltas arrive per token; re-render at most this often for them.
const DELTA_UPDATE_INTERVAL_MS = 250;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_ATTEMPTS = 2;
const MAX_ATTEMPTS_CAP = 5;
const DEFAULT_RETRY_BACKOFF_MS = 1_000;
// Prompt sent to the CHILD agent (not the orchestrator) on a retry attempt:
// it replaces the original task argument, which already lives in the resumed
// child session history.
const CONTINUATION_PROMPT =
	"Your previous run was interrupted before you could finish (provider limit, request stall, timeout, or stop). Continue the original task from this session's history without redoing work already completed, then return the final result.";
function continuationPrompt(task: string): string {
	// A fork may contain only parent history if startup failed before the
	// child's first prompt was saved. Never infer its assignment from that.
	return `${CONTINUATION_PROMPT}\n\nAssigned child task (not the parent's task):\n${task}`;
}

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
	/**
	 * After the child reports agent_settled, how long to wait for its process
	 * to exit before terminating it (default 10s). A reaped child still counts
	 * as completed.
	 */
	settleExitGraceMs?: number;
	/** Clock seam for activity timestamps (default Date.now). */
	now?: () => number;
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

interface ChildLaunch {
	task: SubagentTask;
	request: SubagentRunRequest;
	agent: AgentConfig;
	parent: ParentLaunchContext;
	resumed: boolean;
}

// Private launch snapshots never enter tool details/model context. Weak keys
// let registry pruning release prompts/configuration along with old children.
const childLaunches = new WeakMap<ChildRunStatus, ChildLaunch>();

interface SavedChildSession {
	sessionFile: string;
	transcript?: ChildTranscript;
	from: { runId: string; index: number };
}

interface ParsedChildOutput {
	finalOutput: string;
	model?: string;
	usage: ChildUsage;
	assistantError?: string;
	/** agent_settled was received: pi will not continue this run. */
	settled?: { aborted: boolean };
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

function parseEventLine(line: string): Record<string, unknown> | undefined {
	const clean = line.replace(ANSI_PATTERN, "").trim();
	const objectStart = clean.indexOf("{");
	if (objectStart === -1) return undefined;
	try {
		const event: unknown = JSON.parse(clean.slice(objectStart));
		return typeof event === "object" && event !== null && !Array.isArray(event)
			? (event as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function applyOutputEvent(
	event: Record<string, unknown>,
	parsed: ParsedChildOutput,
): void {
	if (event.type === "agent_settled") {
		parsed.settled = { aborted: event.aborted === true };
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
	return childSupportsModel(childExtensionLaunch(parent), model)
		? model
		: undefined;
}

function childExtensionLaunch(
	parent: ParentLaunchContext,
): ChildExtensionLaunch {
	return enforceChildExtensions(
		parent.extensionLaunch ??
			resolveChildExtensionLaunch({ modelProvider: parent.modelProvider }),
	);
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
	// Mirror the parent's extension set: provider/auth extensions (e.g. an
	// OAuth request shaper) must load in the child or its requests differ.
	const extensionLaunch = childExtensionLaunch(input.parent);
	if (extensionLaunch.noExtensions) args.push("--no-extensions");
	for (const extensionPath of extensionLaunch.paths) {
		args.push("--extension", extensionPath);
	}
	const context = input.request.context ?? "fresh";
	let requestedSessionFile: string | undefined;
	if (input.resumeSessionFile) {
		// --fork cannot be combined with --session; resuming the forked child's
		// own session preserves its progress without re-forking from the parent.
		requestedSessionFile = input.resumeSessionFile;
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
	// Children are headless: any other mode would block every edit and
	// non-read-only command. permission-modes also pins auto for children.
	args.push("--permission-mode", "auto");
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
	const prompt = input.promptOverride ?? `Task: ${input.task.task}`;
	if (prompt.length > TASK_ARG_LIMIT) {
		const taskPath = join(childDir, "task.md");
		writeFileSync(taskPath, prompt, {
			encoding: "utf8",
			mode: 0o600,
		});
		args.push(`@${taskPath}`);
	} else {
		args.push(prompt);
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
	/** Child finished (agent_settled) but lingered; the runner terminated it. */
	reapedAfterSettle: boolean;
	stderr: string;
	parsed: ParsedChildOutput;
	sessionFile?: string;
}

function attemptFailed(outcome: AttemptOutcome): boolean {
	// A child reaped after agent_settled finished its work; the exit code of
	// the termination says nothing about the run.
	const exitedCleanly = outcome.code === 0 || outcome.reapedAfterSettle;
	return (
		outcome.timedOut ||
		outcome.parsed.assistantError !== undefined ||
		!exitedCleanly
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

function nextRetryInputs(outcome: AttemptOutcome, task: string): {
	resumeSessionFile?: string;
	promptOverride?: string;
} {
	if (!outcome.sessionFile) return {};
	const resumeSessionFile = outcome.sessionFile;
	return {
		resumeSessionFile,
		promptOverride: sessionHasUserTurn(resumeSessionFile)
			? continuationPrompt(task)
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
	settleExitGraceMs: number;
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

	const now = input.deps?.now ?? Date.now;
	const activity = (input.status.activity ??= createActivity(now()));
	resetActivityForAttempt(activity, now());
	const terminate = () => {
		process.kill("SIGTERM");
		const killTimer = setTimeout(() => {
			if (process.exitCode === null && process.signalCode === null)
				process.kill("SIGKILL");
		}, input.terminationGraceMs);
		killTimer.unref?.();
	};

	const timeout = setTimeout(() => {
		timedOut = true;
		terminate();
	}, input.timeoutMs);
	timeout.unref?.();

	// Once the child reports agent_settled it has finished. `pi -p` still has
	// to drain its event loop to exit, which a leaked extension handle can
	// block forever; give it a grace period, then reap it.
	let settleTimer: NodeJS.Timeout | undefined;
	let reapedAfterSettle = false;
	const onSettled = () => {
		if (settleTimer) return;
		clearTimeout(timeout);
		settleTimer = setTimeout(() => {
			if (process.exitCode !== null || process.signalCode !== null) return;
			reapedAfterSettle = true;
			terminate();
		}, input.settleExitGraceMs);
		settleTimer.unref?.();
	};

	let lastNotifyAt = 0;
	const stdoutLines = createInterface({ input: process.stdout });
	stdoutLines.on("line", (line) => {
		const event = parseEventLine(line);
		if (!event) return;
		applyOutputEvent(event, parsed);
		if (parsed.finalOutput) input.status.output = parsed.finalOutput;
		const significant = applyActivityEvent(activity, event, now());
		if (input.status.transcript)
			applyTranscriptEvent(input.status.transcript, event, now());
		if (parsed.settled) onSettled();
		const at = now();
		if (
			!significant &&
			event.type !== "message_end" &&
			at - lastNotifyAt < DELTA_UPDATE_INTERVAL_MS
		)
			return;
		lastNotifyAt = at;
		input.onUpdate?.(input.run);
	});
	process.stderr.on("data", (chunk: Buffer | string) => {
		const text = chunk.toString();
		stderr = `${stderr}${text}`.slice(-MAX_STDERR_CHARS);
		if (input.status.transcript)
			appendTranscriptLog(input.status.transcript, text, now());
	});

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
	if (settleTimer) clearTimeout(settleTimer);
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
		reapedAfterSettle,
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
	resume?: SavedChildSession;
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
	input.status.thinking = resolvedThinking(
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
	const settleExitGraceMs =
		input.deps?.settleExitGraceMs ?? DEFAULT_SETTLE_EXIT_GRACE_MS;
	input.status.activity = createActivity((input.deps?.now ?? Date.now)());
	const transcript = input.resume?.transcript ?? createTranscript();
	input.status.transcript = transcript;
	if (input.resume)
		pushTranscriptNotice(
			transcript,
			`Manual resume from run ${input.resume.from.runId.slice(0, 8)} · saved child session`,
			"muted",
		);

	let resumeSessionFile = input.resume?.sessionFile;
	let promptOverride = input.resume ? continuationPrompt(input.task.task) : undefined;
	let outcome: AttemptOutcome | undefined;
	let specError: string | undefined;
	let attempts = 0;
	const totalUsage = emptyUsage();
	let lastOutput = "";
	let lastModel: string | undefined;

	while (attempts < maxAttempts) {
		attempts++;
		input.status.attempts = attempts;
		if (attempts > 1)
			pushTranscriptNotice(
				transcript,
				`attempt ${attempts}/${maxAttempts}${resumeSessionFile ? " · resuming child session" : ""}`,
				"warning",
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
			settleExitGraceMs,
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
		pushTranscriptNotice(
			transcript,
			describedFailure({ outcome, timeoutMs, attempts, maxAttempts }),
			"warning",
		);

		// Resume the child's preserved session so completed turns survive the
		// failed attempt instead of being discarded.
		({ resumeSessionFile, promptOverride } = nextRetryInputs(outcome, input.task.task));
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

	if (state === "failed") pushTranscriptNotice(transcript, error ?? "failed", "error");
	else pushTranscriptNotice(transcript, state, state === "completed" ? "success" : "warning");
	const sessionFile = outcome?.sessionFile ?? input.resume?.sessionFile;
	const reapedAfterSettle =
		state === "completed" && outcome?.reapedAfterSettle === true;
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
		reapedAfterSettle,
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
		thinking: input.status.thinking,
		sessionFile,
		startedAt,
		endedAt,
		usage: totalUsage,
		attempts,
		reapedAfterSettle,
	};
}

export async function executeSubagentRun(
	input: RunInput,
	resume?: SavedChildSession,
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
		model: resolvedModel(task, input.request, resolvedAgents[index], input.parent),
		thinking: resolvedThinking(task, input.request, resolvedAgents[index], input.parent),
	}));
	const mode = tasks.length === 1 ? "single" : "parallel";
	const run = createRun({ mode, context, cwd: input.parent.cwd, children });
	run.state = "running";
	run.resumedFrom = resume?.from;
	for (const [index, child] of children.entries()) {
		childLaunches.set(child, {
			task: { ...tasks[index], model: child.model, thinking: child.thinking },
			request: { context, timeoutMs: input.request.timeoutMs },
			agent: structuredClone(resolvedAgents[index]),
			parent: {
				...input.parent,
				extensionLaunch: structuredClone(childExtensionLaunch(input.parent)),
			},
			resumed: false,
		});
	}
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
				resume,
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

/** Explain why recovery is unavailable; undefined means it can resume now. */
export function childResumeUnavailable(
	run: SubagentRun,
	child: ChildRunStatus,
): string | undefined {
	if (getRun(run.id) !== run || !run.children.includes(child))
		return "This run is no longer in the current session.";
	if (child.state !== "failed" && child.state !== "stopped")
		return "Only failed or stopped children can resume.";
	if (child.process || !run.results.some((result) => result.index === child.index))
		return "The child is still stopping; try again shortly.";
	const launch = childLaunches.get(child);
	if (!launch) return "The original launch configuration is no longer available.";
	if (launch.resumed) return "Already resumed; select the latest continuation run.";
	try {
		if (child.sessionFile && statSync(child.sessionFile).isFile()) return undefined;
	} catch {
		// Missing/unreadable sessions must never silently become fresh runs.
	}
	return "No saved child session is available to resume.";
}

/** Resume as a new single-child run, without mutating the original tool result. */
export async function resumeSubagentChild(input: {
	run: SubagentRun;
	child: ChildRunStatus;
	onUpdate?: (run: SubagentRun) => void;
	deps?: RunnerDeps;
}): Promise<SubagentRun> {
	const reason = childResumeUnavailable(input.run, input.child);
	if (reason) throw new Error(reason);
	const launch = childLaunches.get(input.child);
	const sessionFile = input.child.sessionFile;
	if (!launch || !sessionFile) throw new Error("The saved child launch is unavailable.");
	// Read before claiming the session: fail closed on permissions/removal.
	readFileSync(sessionFile, "utf8");
	const transcript = input.child.transcript
		? structuredClone(input.child.transcript)
		: undefined;
	// Claim synchronously before spawning: repeated r cannot create competing
	// writers to the same saved session, even after a continuation finishes.
	launch.resumed = true;
	return executeSubagentRun(
		{
			request: { ...launch.request, ...launch.task },
			agents: [launch.agent],
			parent: launch.parent,
			onUpdate: input.onUpdate,
			deps: input.deps,
		},
		{
			sessionFile,
			transcript,
			from: { runId: input.run.id, index: input.child.index },
		},
	);
}

export function formatRunResult(run: SubagentRun): string {
	const continuation = run.resumedFrom
		? ` Resumed child #${run.resumedFrom.index + 1} from run ${run.resumedFrom.runId}.`
		: "";
	const header = `Subagent run ${run.id} ${run.state} (${run.mode}, ${run.context} context).${continuation}`;
	const results = run.results.map((result) => {
		const attemptsNote = result.attempts > 1 ? ` (${result.attempts} attempts)` : "";
		const title = `=== ${result.agent} [${result.state}]${attemptsNote} ===`;
		let body = result.output;
		if (result.error)
			body = result.output
				? `${result.error}\n\n${result.output}`
				: result.error;
		if (result.reapedAfterSettle)
			body = `${body}\n\n(Note: the child finished but its process did not exit on its own — a loaded extension likely kept it alive — so it was terminated.)`;
		return `${title}\n${body}`;
	});
	return [header, ...results].join("\n\n");
}
