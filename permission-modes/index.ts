/**
 * permission-modes — a Claude-Code-style Shift+Tab mode extension for the pi coding agent.
 *
 * Four modes, cycled with Shift+Tab:
 *  - default: prompt for file mutations and mutating bash; reads pass through
 *  - ask:     passive Q&A and exploration; mutations blocked, no plan workflow
 *  - plan:    read-only exploration followed by an optional execution workflow
 *  - auto:    auto-approve edits, writes, and mutating bash; no permission prompts
 *
 * See .pi/plan/BUILD.md for the full spec.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { StringEnum, type AssistantMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	buildMutationApprovalPrompt,
	formatMutationPreview,
} from "../diff-tools/core/mutation-preview.js";
import { setPermissionModeAccess } from "./mode-access.js";
import {
	extractTodoItems,
	isSafeCommand,
	markCompletedSteps,
	type TodoItem,
} from "./utils.js";

// ---------- Types ----------

type Mode = "default" | "ask" | "plan" | "auto";

const MODE_CYCLE: Mode[] = ["default", "ask", "plan", "auto"];

const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls"];
const FILE_MUTATION_TOOLS = new Set<string>(["edit", "write", "apply_patch"]);
const PLAN_MODE_DISABLED_TOOLS = FILE_MUTATION_TOOLS;
const CURSOR_BRIDGE_BUILTINS_ENV = "PI_CURSOR_EXPOSE_BUILTIN_TOOLS";
const CURSOR_REPLAY_TOOL_CALL_PREFIX = "cursor-replay-";
const CURSOR_BRIDGE_MUTATION_TOOLS =
	"pi__edit, pi__write, pi__apply_patch, or pi__bash";

interface PersistedState {
	currentMode: Mode;
	toolsBeforePassiveMode?: string[];
	/** Legacy persisted field retained for session compatibility. */
	toolsBeforePlanMode?: string[];
	planExecuting?: boolean;
	planTodos?: TodoItem[];
}

// ---------- Helpers (type guards, text extraction) ----------

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: AssistantMessage): string {
	const text: string[] = [];
	for (const block of message.content) {
		if (block.type === "text") text.push(block.text);
	}
	return text.join("\n");
}

function uniqueToolNames(toolNames: string[]): string[] {
	return [...new Set(toolNames)];
}

function isEnabledEnvValue(value: string | undefined): boolean {
	if (value === undefined) return false;
	return ["1", "true", "on", "yes", "enabled"].includes(
		value.trim().toLowerCase(),
	);
}

function isCursorReplayToolCall(toolCallId: string): boolean {
	return toolCallId.startsWith(CURSOR_REPLAY_TOOL_CALL_PREFIX);
}

function getFileMutationTarget(input: Record<string, unknown>): string {
	if (typeof input.path === "string") return input.path;
	if (!Array.isArray(input.changes)) return "(unknown)";

	const paths = uniqueToolNames(
		input.changes.flatMap((change) => {
			if (typeof change !== "object" || change === null) return [];
			const path = (change as Record<string, unknown>).path;
			return typeof path === "string" ? [path] : [];
		}),
	);
	if (paths.length === 0) return "(unknown)";
	if (paths.length <= 3) return paths.join(", ");
	return `${paths.slice(0, 3).join(", ")} (+${paths.length - 3} more)`;
}

function getCursorReplayMutation(
	tool: string,
	input: Record<string, unknown>,
): string | undefined {
	if (FILE_MUTATION_TOOLS.has(tool)) return tool;
	if (tool === "bash") {
		const command = String(input.command ?? "");
		return isSafeCommand(command) ? undefined : "shell command";
	}
	if (tool !== "cursor") return undefined;

	const label = [input.activityTitle, input.sourceToolName, input.toolName]
		.filter((value): value is string => typeof value === "string")
		.join(" ");
	const mutation = label.match(/\b(edit|write|delete|shell)\b/i)?.[1];
	return mutation?.toLowerCase();
}

function isPassiveMode(mode: Mode): boolean {
	return mode === "ask" || mode === "plan";
}

function cursorModeGuidance(mode: Mode): string {
	if (mode === "auto") return "";
	if (isPassiveMode(mode)) {
		const fallback =
			mode === "plan"
				? "Describe requested mutations in the plan instead."
				: "Answer the user's request without making changes or creating a plan unless they explicitly request one.";
		return `[CURSOR PROVIDER SAFETY]
Cursor host tools execute inside the headless Cursor SDK and bypass Pi's tool_call gate.
Do not use Cursor host edit, write, delete, or mutating shell tools in ${mode} mode. Use only read/search operations. ${fallback}`;
	}

	return `[CURSOR PROVIDER PERMISSION ROUTING]
Cursor host edit/write/delete/shell tools bypass Pi's permission prompt. For every file mutation or mutating command, use the exposed Pi bridge tools (${CURSOR_BRIDGE_MUTATION_TOOLS}) instead of Cursor host tools so Pi can show the diff and ask before execution. Cursor host read/search tools remain allowed. If the required pi__ tool is unavailable, do not mutate anything; explain that permission routing is unavailable.`;
}

export function modeMetadata(mode: Mode): {
	icon: string;
	label: string;
	role: "muted" | "warning" | "accent";
} {
	switch (mode) {
		case "default":
			return { icon: "●", label: "Default", role: "muted" };
		case "ask":
			return { icon: "?", label: "Ask", role: "accent" };
		case "plan":
			return { icon: "⏸", label: "Plan", role: "warning" };
		case "auto":
			return { icon: "▶", label: "Auto", role: "accent" };
		default:
			return { icon: "●", label: "Default", role: "muted" };
	}
}

function normalizeModeFlag(value: unknown): Mode {
	if (typeof value !== "string") return "default";
	const v = value.toLowerCase();
	if (v === "ask" || v === "plan" || v === "auto" || v === "default") return v;
	// Legacy mappings
	if (v === "normal") return "default";
	if (v === "accept-edits") return "auto";
	return "default";
}

// ---------- Extension factory ----------

export function registerPermissionModes(pi: ExtensionAPI): void {
	// ---- Closure state ----
	let currentMode: Mode = "default";
	let toolsBeforePassiveMode: string[] | undefined;
	let planExecuting = false;
	let planTodos: TodoItem[] = [];
	let enabledCursorBridgeBuiltins = false;

	function syncCursorPermissionBridge(ctx: ExtensionContext): void {
		const shouldEnable =
			ctx.model?.provider === "cursor" && currentMode === "default";
		if (shouldEnable && process.env[CURSOR_BRIDGE_BUILTINS_ENV] === undefined) {
			// Cursor's headless host tools bypass Pi hooks. Expose overlapping Pi
			// built-ins so mutations can route through the normal permission gate.
			process.env[CURSOR_BRIDGE_BUILTINS_ENV] = "1";
			enabledCursorBridgeBuiltins = true;
		} else if (!shouldEnable && enabledCursorBridgeBuiltins) {
			delete process.env[CURSOR_BRIDGE_BUILTINS_ENV];
			enabledCursorBridgeBuiltins = false;
		}
	}

	// Stream stats removed — aio status-line owns footer and working message.

	function renderPlanTodoLines(ctx: ExtensionContext): string[] {
		return planTodos.map((item) => {
			if (item.completed) {
				return (
					ctx.ui.theme.fg("success", "☑ ") +
					ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
				);
			}
			return `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`;
		});
	}

	function syncPlanTodoWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (planTodos.length === 0) {
			ctx.ui.setWidget("plan-todos", undefined);
			return;
		}
		ctx.ui.setWidget("plan-todos", renderPlanTodoLines(ctx));
	}

	function buildPlanExecutionBody(): string {
		const remainingList = planTodos
			.map((t) => `${t.step}. ${t.text}`)
			.join("\n");
		const firstStep = planTodos[0];
		const todoHint =
			planTodos.length > 2
				? "\nUse the todo tool to list and toggle the steps as you finish them."
				: "";
		return `Execute the plan now. Steps:

${remainingList}

Start with: ${firstStep ? firstStep.text : "(first step)"}${todoHint}
After finishing each step, include a [DONE:n] tag in your response.`;
	}

	// ---- Register CLI flag ----
	pi.registerFlag("permission-mode", {
		description: "Start in a permission mode: default | ask | plan | auto",
		type: "string",
		default: "default",
	});

	// ---- Register direct mode commands and /mode ----

	pi.registerCommand("default", {
		description: "Switch to default mode (prompt for edits & mutating bash)",
		handler: async (_args, ctx) => {
			await setMode("default", ctx);
		},
	});

	pi.registerCommand("ask", {
		description: "Switch to ask mode (passive read-only Q&A)",
		handler: async (_args, ctx) => {
			await setMode("ask", ctx);
		},
	});

	pi.registerCommand("plan", {
		description: "Switch to plan mode (read-only planning)",
		handler: async (_args, ctx) => {
			await setMode("plan", ctx);
		},
	});

	pi.registerCommand("auto", {
		description: "Switch to auto mode (auto-approve without follow-up prompts)",
		handler: async (_args, ctx) => {
			await setMode("auto", ctx);
		},
	});

	pi.registerCommand("mode", {
		description: "Show or change the current permission mode",
		handler: async (args, ctx) => {
			const trimmed = (args ?? "").trim().toLowerCase();
			if (!trimmed) {
				if (!ctx.hasUI) {
					ctx.ui.notify(`Mode: ${currentMode}`);
					return;
				}
				const choice = await ctx.ui.select(
					`Mode: ${currentMode} — switch to:`,
					["default", "ask", "plan", "auto"],
				);
				if (choice) await setMode(choice as Mode, ctx);
				return;
			}
			if (
				trimmed === "default" ||
				trimmed === "ask" ||
				trimmed === "plan" ||
				trimmed === "auto"
			) {
				await setMode(trimmed, ctx);
			} else {
				ctx.ui.notify(
					`Unknown mode "${trimmed}". Use: default | ask | plan | auto`,
					"error",
				);
			}
		},
	});

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Manage the active plan todo list. Actions: list, toggle (step), create (text, optional position), rename (step, text), reorder (step, position), delete (step)",
		promptSnippet: "Track plan steps and mark each step done with todo action=toggle",
		promptGuidelines: [
			"When executing a numbered plan, call todo action=toggle for the matching step immediately after that step's work is finished, before starting the next step.",
			"Use todo action=list at the start of plan execution and again whenever you need to confirm which steps remain.",
			"Do not leave completed steps unchecked; toggle flips completion state, so only call it once per finished step.",
			"After toggling a step, briefly note what was completed in your response so the user can see progress.",
		],
		parameters: Type.Object({
			action: StringEnum([
				"list",
				"toggle",
				"create",
				"rename",
				"reorder",
				"delete",
			] as const),
			step: Type.Optional(
				Type.Integer({
					minimum: 1,
					description: "Step number (for toggle, rename, reorder, or delete)",
				}),
			),
			text: Type.Optional(
				Type.String({ description: "Step text (for create or rename)" }),
			),
			position: Type.Optional(
				Type.Integer({
					minimum: 1,
					description:
						"1-based insertion or destination position (for create or reorder)",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const snapshot = (): TodoItem[] => planTodos.map((item) => ({ ...item }));
			const result = (text: string, error?: string) => ({
				content: [{ type: "text" as const, text }],
				details: {
					action: params.action,
					todos: snapshot(),
					...(error ? { error } : {}),
				},
			});
			const renumber = (): void => {
				for (const [index, item] of planTodos.entries()) {
					item.step = index + 1;
				}
			};
			const findStep = (step: number): TodoItem | undefined =>
				planTodos.find((item) => item.step === step);

			if (params.action === "list") {
				let text = "No active todo list";
				if (planTodos.length > 0) {
					text = planTodos
						.map((item) => {
							const marker = item.completed ? "[x]" : "[ ]";
							return `${marker} #${item.step}: ${item.text}`;
						})
						.join("\n");
				}
				return result(text);
			}

			if (params.action === "create") {
				const text = params.text?.trim();
				if (!text) {
					return result("Error: text required for create", "text required");
				}
				const position = params.position ?? planTodos.length + 1;
				if (
					!Number.isInteger(position) ||
					position < 1 ||
					position > planTodos.length + 1
				) {
					const error = `position must be between 1 and ${planTodos.length + 1}`;
					return result(`Error: ${error}`, error);
				}
				planTodos.splice(position - 1, 0, {
					step: position,
					text,
					completed: false,
				});
				renumber();
				syncPlanTodoWidget(ctx);
				return result(`Created step ${position}: ${text}`);
			}

			const step = params.step;
			if (!Number.isInteger(step) || (step ?? 0) < 1) {
				return result(
					`Error: step required for ${params.action}`,
					"step required",
				);
			}

			const item = findStep(step as number);
			if (!item) {
				const error = `step ${step} not found`;
				return result(`Step ${step} not found`, error);
			}

			if (params.action === "toggle") {
				item.completed = !item.completed;
				syncPlanTodoWidget(ctx);
				return result(`Step ${step} ${item.completed ? "done" : "undone"}`);
			}

			if (params.action === "rename") {
				const text = params.text?.trim();
				if (!text) {
					return result("Error: text required for rename", "text required");
				}
				item.text = text;
				syncPlanTodoWidget(ctx);
				return result(`Renamed step ${step}: ${text}`);
			}

			if (params.action === "reorder") {
				const position = params.position;
				if (
					!Number.isInteger(position) ||
					(position ?? 0) < 1 ||
					(position ?? 0) > planTodos.length
				) {
					const error = `position must be between 1 and ${planTodos.length}`;
					return result(`Error: ${error}`, error);
				}
				const currentIndex = planTodos.indexOf(item);
				planTodos.splice(currentIndex, 1);
				planTodos.splice((position as number) - 1, 0, item);
				renumber();
				syncPlanTodoWidget(ctx);
				return result(`Moved step ${step} to position ${position}`);
			}

			planTodos.splice(planTodos.indexOf(item), 1);
			renumber();
			syncPlanTodoWidget(ctx);
			return result(`Deleted step ${step}: ${item.text}`);
		},
	});

	// ---- Register Shift+Tab shortcut ----

	pi.registerShortcut("shift+tab", {
		description: "Cycle permission mode (default → ask → plan → auto)",
		handler: async (ctx) => {
			const idx = MODE_CYCLE.indexOf(currentMode);
			const next = MODE_CYCLE[(idx + 1) % MODE_CYCLE.length] ?? "default";
			await setMode(next, ctx);
			ctx.ui.notify(`Mode: ${next}`, "info");
		},
	});

	// ---------- setMode: the central state mutator ----------

	async function setMode(mode: Mode, ctx: ExtensionContext): Promise<void> {
		const prev = currentMode;
		currentMode = mode;

		// Reset transient plan state on every mode switch
		planExecuting = false;
		planTodos = [];

		// Ask and plan share the same passive tool restrictions. Switching
		// between them keeps the original active-tool snapshot intact.
		if (isPassiveMode(mode) && !isPassiveMode(prev)) {
			if (toolsBeforePassiveMode === undefined) {
				toolsBeforePassiveMode = pi.getActiveTools();
			}
			pi.setActiveTools(
				uniqueToolNames([
					...toolsBeforePassiveMode.filter(
						(t) => !PLAN_MODE_DISABLED_TOOLS.has(t),
					),
					...PLAN_MODE_TOOLS,
				]),
			);
		} else if (!isPassiveMode(mode) && isPassiveMode(prev)) {
			pi.setActiveTools(toolsBeforePassiveMode ?? pi.getActiveTools());
			toolsBeforePassiveMode = undefined;
		}

		// Clear plan widget on any non-plan mode
		if (mode !== "plan" && ctx.hasUI) {
			ctx.ui.setWidget("plan-todos", undefined);
		}

		syncCursorPermissionBridge(ctx);

		// Update status pill + working indicator
		updateStatus(ctx);

		persistState();
	}

	setPermissionModeAccess({
		getMode: () => currentMode,
		setMode,
	});

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const meta = modeMetadata(currentMode);
		ctx.ui.setStatus(
			"modes",
			ctx.ui.theme.fg(meta.role, `${meta.icon} ${meta.label}`),
		);
		const indicator: WorkingIndicatorOptions = {
			frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"].map((f) =>
				ctx.ui.theme.fg(meta.role, f),
			),
			intervalMs: 80,
		};
		ctx.ui.setWorkingIndicator(indicator);
	}

	function persistState(): void {
		const state: PersistedState = {
			currentMode,
			toolsBeforePassiveMode,
		};
		pi.appendEntry("modes", state);
	}

	// ---------- tool_call gate (the single handler) ----------

	pi.on("tool_call", async (event, ctx) => {
		const tool = event.toolName;
		const input = (event.input ?? {}) as Record<string, unknown>;

		// pi-cursor-sdk replay calls only display work that Cursor's host already
		// completed. Prompting here would be misleading because it cannot prevent
		// the mutation. Allow the replay card and warn if routing was bypassed.
		if (isCursorReplayToolCall(event.toolCallId)) {
			const mutation = getCursorReplayMutation(tool, input);
			if (mutation && currentMode !== "auto" && ctx.hasUI) {
				ctx.ui.notify(
					`Cursor host ${mutation} bypassed ${currentMode} mode; the action already ran outside Pi's permission gate. Use ${CURSOR_BRIDGE_MUTATION_TOOLS} so Pi can show the diff and prompt before execution.`,
					"warning",
				);
			}
			return undefined;
		}

		if (isPassiveMode(currentMode)) {
			const label = currentMode === "ask" ? "Ask" : "Plan";
			if (FILE_MUTATION_TOOLS.has(tool)) {
				return {
					block: true,
					reason: `${label} mode: ${tool} disabled. Switch modes to make changes.`,
				};
			}
			if (tool === "bash") {
				const cmd = String(input.command ?? "");
				if (!isSafeCommand(cmd)) {
					return {
						block: true,
						reason: `${label} mode: read-only commands only.\n  Command: ${cmd}`,
					};
				}
			}
			return undefined;
		}

		if (currentMode === "auto") {
			return undefined; // approve everything
		}

		// default mode
		if (FILE_MUTATION_TOOLS.has(tool)) {
			const path = getFileMutationTarget(input);
			if (!ctx.hasUI) {
				return { block: true, reason: `${tool} blocked: no UI to confirm.` };
			}
			const preview =
				tool === "edit" || tool === "apply_patch"
					? await formatMutationPreview(tool, input)
					: undefined;
			const choice = await ctx.ui.select(
				buildMutationApprovalPrompt(tool, path, preview),
				["Allow", "Allow all (enable auto)", "Block"],
			);
			if (choice === "Allow all (enable auto)") {
				await setMode("auto", ctx);
				return undefined;
			}
			if (choice !== "Allow") {
				return { block: true, reason: `${tool} blocked by user on ${path}` };
			}
			return undefined;
		}

		if (tool === "bash") {
			const cmd = String(input.command ?? "");
			if (isSafeCommand(cmd)) return undefined; // read-only: allow
			if (!ctx.hasUI) {
				return { block: true, reason: "bash blocked: no UI to confirm." };
			}
			const choice = await ctx.ui.select(`Allow bash "${cmd}"?`, [
				"Allow",
				"Block",
			]);
			return choice === "Allow"
				? undefined
				: { block: true, reason: "bash blocked by user" };
		}

		// reads and anything else: pass through
		return undefined;
	});

	// ---------- context dedup (keep only the latest modes-context) ----------

	pi.on("context", async (event) => {
		const all = event.messages;
		let latestIdx = -1;
		for (let i = all.length - 1; i >= 0; i--) {
			const m = all[i] as AgentMessage & { customType?: string };
			if (m.customType === "modes-context") {
				latestIdx = i;
				break;
			}
		}
		const filtered = all.filter((m, i) => {
			const msg = m as AgentMessage & { customType?: string };
			if (msg.customType === "modes-context") return i === latestIdx;
			return true;
		});
		return { messages: filtered };
	});

	// ---------- before_agent_start: inject mode context ----------

	pi.on("before_agent_start", async (_event, ctx) => {
		syncCursorPermissionBridge(ctx);

		if (planExecuting && planTodos.length > 0) {
			const remaining = planTodos.filter((t) => !t.completed);
			const todoList = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
			const todoHint =
				planTodos.length > 0
					? "\nAfter each step finishes, call todo({ action: \"toggle\", step: n }) for that step before moving on. Use todo({ action: \"list\" }) to verify nothing is left unchecked."
					: "";
			return {
				message: {
					customType: "modes-context",
					content: `[EXECUTING PLAN — full tool access]

Remaining steps:
${todoList}
${todoHint}

Execute each step in order. Mark progress in the todo tool as you go; do not batch toggles at the end.`,
					display: false,
				},
			};
		}

		let body: string;
		if (currentMode === "ask") {
			body = `[ASK MODE ACTIVE]
You are in ask mode — a passive, read-only mode for questions, explanations, and codebase exploration.

Restrictions:
- edit, write, and apply_patch tools are disabled
- bash is restricted to an allowlist of read-only commands
- reads (read/grep/find/ls) pass through

Answer the user's request directly. Inspect the codebase when useful, but do not modify files or system state.
Do not create an implementation plan unless the user explicitly asks for one.`;
		} else if (currentMode === "plan") {
			body = `[PLAN MODE ACTIVE]
You are in plan mode — a read-only exploration mode for safe code analysis.

Restrictions:
- edit, write, and apply_patch tools are disabled
- bash is restricted to an allowlist of read-only commands
- reads (read/grep/find/ls) pass through

Create a detailed numbered plan under a "Plan:" header:

Plan:
1. First step description
2. Second step description
...

Do NOT attempt to make changes — just describe what you would do.`;
		} else if (currentMode === "auto") {
			body = `[AUTO MODE ACTIVE]
All tool calls (edit, write, bash) are auto-approved — no permission prompts.
Proceed without asking for confirmation. After completing each meaningful chunk, briefly summarize progress.
If a todo list is active, toggle each finished step with the todo tool before continuing.`;
		} else {
			body = `[DEFAULT MODE ACTIVE]
- edit, write, and apply_patch tools require per-call user approval
- mutating bash commands require per-call user approval
- read-only bash and reads (read/grep/find/ls) pass through without prompting`;
		}

		if (ctx.model?.provider === "cursor") {
			const guidance = cursorModeGuidance(currentMode);
			if (guidance) body += `\n\n${guidance}`;
			if (
				currentMode === "default" &&
				!isEnabledEnvValue(process.env[CURSOR_BRIDGE_BUILTINS_ENV])
			) {
				body += `\n\nPi bridge mutation tools are currently unavailable because ${CURSOR_BRIDGE_BUILTINS_ENV} is disabled. Do not mutate files or run mutating commands.`;
			}
		}

		return {
			message: {
				customType: "modes-context",
				content: body,
				display: false,
			},
		};
	});

	// ---------- turn_end: plan execution progress ----------

	pi.on("turn_end", async (event, ctx) => {
		const last = event.message;
		if (!last || !isAssistantMessage(last)) return;

		if (planExecuting && planTodos.length > 0) {
			const text = getTextContent(last);
			markCompletedSteps(text, planTodos);
			syncPlanTodoWidget(ctx);
			persistState();
		}
	});

	// ---------- agent_end: plan flow (Execute/Stay/Refine) (runs second) ----------

	pi.on("agent_end", async (event, ctx) => {
		// Plan execution completion: if all todos done, post completion + clear
		if (planExecuting && planTodos.length > 0) {
			if (planTodos.every((t) => t.completed)) {
				const completedList = planTodos.map((t) => `~~${t.text}~~`).join("\n");
				pi.sendMessage(
					{
						customType: "plan-complete",
						content: `**Plan Complete!** ✓\n\n${completedList}`,
						display: true,
					},
					{ triggerTurn: false },
				);
				planExecuting = false;
				planTodos = [];
				if (ctx.hasUI) ctx.ui.setWidget("plan-todos", undefined);
				updateStatus(ctx);
				persistState();
			}
			return;
		}

		if (currentMode !== "plan") return;
		if (!ctx.hasUI) return;

		// Find last assistant message
		const lastAssistant = event.messages.toReversed().find(isAssistantMessage);
		if (!lastAssistant) return;

		const extracted = extractTodoItems(getTextContent(lastAssistant));
		if (extracted.length === 0) return;
		planTodos = extracted;
		persistState();

		const todoListText = planTodos
			.map((t) => `${t.step}. ☐ ${t.text}`)
			.join("\n");
		const planTodoListMessage = {
			customType: "modes-plan-list",
			content: `**Plan Steps (${planTodos.length}):**\n\n${todoListText}`,
			display: true,
		};

		const choice = await ctx.ui.select("Plan ready — what next?", [
			"Execute the plan",
			"Stay in plan mode",
			"Refine the plan",
		]);

		if (!choice) return;

		if (choice.startsWith("Execute")) {
			// Switch into plan-execute flow (auto mode semantics)
			planExecuting = true;
			// Restore tools
			pi.setActiveTools(toolsBeforePassiveMode ?? pi.getActiveTools());
			toolsBeforePassiveMode = undefined;
			currentMode = "auto";
			updateStatus(ctx);
			persistState();

			// Initial widget
			const execBody = buildPlanExecutionBody();
			syncPlanTodoWidget(ctx);

			pi.sendMessage(planTodoListMessage, { deliverAs: "followUp" });
			pi.sendMessage(
				{
					customType: "modes-execute",
					content: execBody,
					display: true,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} else if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Refine the plan:", "");
			if (refinement && refinement.trim()) {
				pi.sendMessage(planTodoListMessage, { deliverAs: "followUp" });
				pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
			}
		}
		// "Stay in plan mode" — do nothing
	});

	// ---------- session_start / session_tree: restore state ----------

	async function restoreSession(ctx: ExtensionContext): Promise<void> {
		// 1) Read --permission-mode flag first
		const flag = pi.getFlag("permission-mode");
		currentMode = normalizeModeFlag(flag);
		planExecuting = false;
		planTodos = [];

		// 2) Let the latest persisted "modes" entry override
		try {
			const entries = ctx.sessionManager.getEntries();
			const modesEntry = entries
				.filter(
					(e) =>
						(e as { type?: string }).type === "custom" &&
						(e as { customType?: string }).customType === "modes",
				)
				.pop() as { data?: PersistedState } | undefined;
			if (modesEntry?.data) {
				currentMode = normalizeModeFlag(modesEntry.data.currentMode);
				toolsBeforePassiveMode =
					modesEntry.data.toolsBeforePassiveMode ??
					modesEntry.data.toolsBeforePlanMode;
			}

			// 3) If we were mid-plan-execution, re-scan assistant and todo messages after the last execute marker
			const executeMarker = entries
				.filter(
					(e) =>
						(e as { type?: string }).type === "custom" &&
						(e as { customType?: string }).customType === "modes-execute",
				)
				.pop();
			if (executeMarker) {
				const executeIndex = entries.indexOf(executeMarker as never);
				let extracted: TodoItem[] = [];
				for (let i = executeIndex + 1; i < entries.length; i++) {
					const entry = entries[i] as {
						type?: string;
						message?: AgentMessage & { toolName?: string; details?: unknown };
					};
					if (entry.type !== "message" || !entry.message) continue;
					if (isAssistantMessage(entry.message)) {
						const items = extractTodoItems(getTextContent(entry.message));
						if (items.length > 0) extracted = items;
						continue;
					}
					if (
						entry.message.role === "toolResult" &&
						entry.message.toolName === "todo"
					) {
						const details = entry.message.details as
							| { todos?: TodoItem[] }
							| undefined;
						if (Array.isArray(details?.todos) && details.todos.length > 0) {
							extracted = details.todos.map((item) => ({ ...item }));
						}
					}
				}
				if (extracted.length > 0) {
					planTodos = extracted;
					planExecuting = true;
					// Executing = auto mode semantics (write/edit/auto-approve)
					currentMode = "auto";
					const allText = entries
						.slice(executeIndex + 1)
						.map((e) => {
							const entry = e as { type?: string; message?: AgentMessage };
							if (
								entry.type === "message" &&
								entry.message &&
								isAssistantMessage(entry.message)
							) {
								return getTextContent(entry.message);
							}
							return "";
						})
						.join("\n");
					markCompletedSteps(allText, planTodos);
				}
			}
		} catch (err) {
			ctx.ui.notify(
				`modes: failed to restore session state: ${err instanceof Error ? err.message : String(err)}`,
				"warning",
			);
		}

		// 4) Apply passive-mode tool restrictions
		if (isPassiveMode(currentMode)) {
			toolsBeforePassiveMode ??= pi.getActiveTools();
			pi.setActiveTools(
				uniqueToolNames([
					...toolsBeforePassiveMode.filter(
						(t) => !PLAN_MODE_DISABLED_TOOLS.has(t),
					),
					...PLAN_MODE_TOOLS,
				]),
			);
		} else if (
			!isPassiveMode(currentMode) &&
			toolsBeforePassiveMode !== undefined
		) {
			// Leftover from a previous passive-mode run — discard.
			toolsBeforePassiveMode = undefined;
		}

		// 5) Restore plan-execute widget if applicable
		syncPlanTodoWidget(ctx);

		syncCursorPermissionBridge(ctx);

		// 6) Restore status pill
		updateStatus(ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		await restoreSession(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		await restoreSession(ctx);
	});

	pi.on("session_shutdown", async () => {
		if (!enabledCursorBridgeBuiltins) return;
		delete process.env[CURSOR_BRIDGE_BUILTINS_ENV];
		enabledCursorBridgeBuiltins = false;
	});
}
