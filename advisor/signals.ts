/**
 * Pure logic that turns tool results into advisor signals: per-run event
 * summaries, stage detection, and executor signals. Ported from pi-advisor
 * (MIT, RimuruW — see advisor/LICENSE and advisor/UPSTREAM.md) and adapted to
 * AIO's tool names (`apply_patch`, `hypa_shell`, `hypa_read`). No Pi imports.
 */

export type AdvisorStage = "initial" | "recovery" | "final-check";
export const ADVISOR_STAGES = ["initial", "recovery", "final-check"] as const;

export interface AdvisorStageInfo {
	stage: AdvisorStage;
	reason: string;
}

export interface RunToolEvent {
	toolName: string;
	summary: string;
	command?: string;
	isError: boolean;
	timestamp: number;
}

export interface ExecutorSignals {
	phase: "exploring" | "mutating" | "verifying" | "stuck";
	mutationsCount: number;
	verificationCommands: string[];
	recentFailures: string[];
}

/** Structural subset of pi's ToolResultEvent. */
export interface ToolResultLike {
	toolName: string;
	input?: Record<string, unknown>;
	content?: unknown;
	isError: boolean;
	details?: unknown;
}

export const MUTATION_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "apply_patch"]);
export const SHELL_TOOLS: ReadonlySet<string> = new Set(["bash", "hypa_shell"]);
export const READ_TOOLS: ReadonlySet<string> = new Set(["read", "hypa_read"]);

function squeezeWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function extractPrimaryText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: string; text: string } =>
				Boolean(block) &&
				typeof block === "object" &&
				(block as { type?: string }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string",
		)
		.map((block) => block.text)
		.join("\n")
		.trim();
}

/** Pi's bash tool reports failures as "Command exited with code N". */
export function extractExitCode(text: string): number | undefined {
	const match = text.match(/exit(?:ed)?\s+(?:with\s+)?code:?\s*(\d+)/i);
	if (!match?.[1]) return undefined;
	const code = Number.parseInt(match[1], 10);
	return Number.isNaN(code) ? undefined : code;
}

export function countPatchChanges(patch: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of patch.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

function mutationTarget(input: Record<string, unknown> | undefined): string {
	if (typeof input?.path === "string") return input.path;
	if (Array.isArray(input?.changes)) {
		const paths = input.changes
			.map((change) => (change as { path?: unknown })?.path)
			.filter((path): path is string => typeof path === "string");
		if (paths.length > 0) return paths.length === 1 ? (paths[0] ?? "") : `${paths.length} files`;
	}
	return "(unknown path)";
}

function patchStats(details: unknown): string {
	const record = details as { patch?: unknown; diff?: unknown } | undefined;
	const patch = typeof record?.patch === "string" ? record.patch : record?.diff;
	if (typeof patch !== "string" || patch.length === 0) return "";
	const { added, removed } = countPatchChanges(patch);
	return ` (+${added}/-${removed})`;
}

export function summarizeToolResult(event: ToolResultLike, now: number = Date.now()): RunToolEvent {
	const { toolName, input, content, isError } = event;
	if (READ_TOOLS.has(toolName)) {
		const path = typeof input?.path === "string" ? input.path : "(unknown path)";
		return { toolName, summary: `read ${path}`, isError, timestamp: now };
	}
	if (MUTATION_TOOLS.has(toolName)) {
		const summary = `${toolName} ${mutationTarget(input)}${patchStats(event.details)}`;
		return { toolName, summary, isError, timestamp: now };
	}
	const text = extractPrimaryText(content);
	if (SHELL_TOOLS.has(toolName)) {
		const command =
			typeof input?.command === "string" ? squeezeWhitespace(input.command).slice(0, 140) : undefined;
		const exitCode = extractExitCode(text);
		let suffix = "";
		if (exitCode !== undefined) suffix = ` (exit ${exitCode})`;
		else if (isError) suffix = " (error)";
		return {
			toolName,
			summary: `$ ${command ?? "(unknown command)"}${suffix}`,
			command,
			isError: isError || (exitCode !== undefined && exitCode !== 0),
			timestamp: now,
		};
	}
	const oneLine = squeezeWhitespace(text).slice(0, 140);
	return { toolName, summary: oneLine ? `${toolName}: ${oneLine}` : toolName, isError, timestamp: now };
}

const VERIFICATION_SEGMENT_PATTERNS: RegExp[] = [
	/^(?:npx\s+|bunx\s+)?(?:jest|vitest|pytest|rspec|tsc|eslint|biome|mocha|ava|tsx\s+--test)\b/,
	/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|tests|check|lint|typecheck|build)\b/,
	/^(?:npm|pnpm|yarn|bun)\s+run\s+test:\S+/,
	/^cargo\s+(?:test|check|clippy|build)\b/,
	/^go\s+(?:test|vet|build)\b/,
	/^make\s+(?:test|check|lint|build)\b/,
	/^node\s+--test\b/,
	/^python3?\s+-m\s+pytest\b/,
];

/** Match per pipeline segment, so `cat tests/foo.test.ts` is not a test run. */
export function isVerificationCommand(command?: string): boolean {
	if (!command) return false;
	return command.split(/&&|\|\||;|\|/).some((segment) => {
		const normalized = segment.trim().replace(/^(?:\w+=\S+\s+)+/, "");
		return VERIFICATION_SEGMENT_PATTERNS.some((pattern) => pattern.test(normalized));
	});
}

function isVerificationEvent(event: Pick<RunToolEvent, "toolName" | "command">): boolean {
	return SHELL_TOOLS.has(event.toolName) && isVerificationCommand(event.command);
}

export function detectStage(events: RunToolEvent[], callNumber: number): AdvisorStageInfo {
	const hasMutation = events.some((event) => MUTATION_TOOLS.has(event.toolName));
	const hasVerification = events.some(isVerificationEvent);
	const recentFailure = events.findLast((event) => event.isError);
	const explorationCount = events.filter(
		(event) => READ_TOOLS.has(event.toolName) || SHELL_TOOLS.has(event.toolName),
	).length;

	if (hasMutation && hasVerification) {
		return {
			stage: "final-check",
			reason: "Implementation changes exist and verification output is already in the transcript.",
		};
	}
	if (recentFailure) {
		return { stage: "recovery", reason: `Recent failure signal: ${recentFailure.summary}` };
	}
	if (hasMutation && callNumber > 1) {
		return {
			stage: "recovery",
			reason: "Implementation has started and the executor is checking course again before finishing.",
		};
	}
	if (!hasMutation && explorationCount >= 2) {
		return {
			stage: "initial",
			reason: "Exploratory reads or commands have happened, but the executor has not committed to file changes yet.",
		};
	}
	if (hasMutation) {
		return {
			stage: "recovery",
			reason: "Implementation is in progress, but there is not enough verification evidence yet for a final check.",
		};
	}
	return { stage: "initial", reason: "The executor is still in the early orientation phase." };
}

export function buildExecutorSignals(events: RunToolEvent[]): ExecutorSignals {
	const mutationsCount = events.filter((event) => MUTATION_TOOLS.has(event.toolName)).length;
	const verificationCommands = events
		.filter((event): event is RunToolEvent & { command: string } => isVerificationEvent(event))
		.map((event) => event.command);
	const recentFailures = events
		.filter((event) => event.isError)
		.slice(-3)
		.map((event) => event.summary);

	let phase: ExecutorSignals["phase"] = "exploring";
	if (mutationsCount > 0 && verificationCommands.length > 0) phase = "verifying";
	else if (mutationsCount > 0) phase = "mutating";
	else if (recentFailures.length > 0) phase = "stuck";

	return { phase, mutationsCount, verificationCommands, recentFailures };
}
