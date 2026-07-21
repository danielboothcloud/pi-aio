/**
 * permission-modes — a Claude-Code-style Shift+Tab mode extension for the pi coding agent.
 *
 * Three modes, cycled with Shift+Tab:
 *  - default: prompt for edit/write and mutating bash; reads pass through
 *  - plan:    read-only exploration; edit/write removed, bash restricted to allowlist
 *  - auto:    auto-approve edits, writes, and mutating bash; no permission prompts
 *
 * See .pi/plan/BUILD.md for the full spec.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	extractTodoItems,
	formatCount,
	isSafeCommand,
	markCompletedSteps,
	type TodoItem,
} from "./utils.js";

// ---------- Types ----------

type Mode = "default" | "plan" | "auto";

const MODE_CYCLE: Mode[] = ["default", "plan", "auto"];

const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls"];
const PLAN_MODE_DISABLED_TOOLS = new Set<string>(["edit", "write"]);

interface PersistedState {
	currentMode: Mode;
	toolsBeforePlanMode?: string[];
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

function modeMetadata(mode: Mode): {
	icon: string;
	label: string;
	role: "muted" | "warning" | "accent";
} {
	switch (mode) {
		case "default":
			return { icon: "●", label: "Default", role: "muted" };
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
	if (v === "plan" || v === "auto" || v === "default") return v;
	// Legacy mappings
	if (v === "ask" || v === "normal") return "default";
	if (v === "accept-edits") return "auto";
	return "default";
}

// ---------- Extension factory ----------

export function registerPermissionModes(pi: ExtensionAPI): void {
	// ---- Closure state ----
	let currentMode: Mode = "default";
	let toolsBeforePlanMode: string[] | undefined;
	let planExecuting = false;
	let planTodos: TodoItem[] = [];

	// Stream stats cache (for working message). Kept on the closure so it
	// survives across events but is reset on each new turn.
	let streamStart = 0;
	let outputAtTurnStart = 0;

	// Cached git branch (read once on session_start, refreshed via footerData events)
	let gitBranch: string | null = null;

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
		description: "Start in a permission mode: default | plan | auto",
		type: "string",
		default: "default",
	});

	// ---- Register /default, /plan, /auto, and /mode commands ----

	pi.registerCommand("default", {
		description: "Switch to default mode (prompt for edits & mutating bash)",
		handler: async (_args, ctx) => {
			await setMode("default", ctx);
		},
	});

	pi.registerCommand("plan", {
		description: "Switch to plan mode (read-only; edit/write disabled)",
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
					["default", "plan", "auto"],
				);
				if (choice) await setMode(choice as Mode, ctx);
				return;
			}
			if (trimmed === "default" || trimmed === "plan" || trimmed === "auto") {
				await setMode(trimmed, ctx);
			} else {
				ctx.ui.notify(
					`Unknown mode "${trimmed}". Use: default | plan | auto`,
					"error",
				);
			}
		},
	});

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: "Inspect and update the active plan todo list",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("list"), Type.Literal("toggle")]),
			step: Type.Optional(Type.Number()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
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
				return {
					content: [{ type: "text", text }],
					details: { action: "list", todos: [...planTodos] },
				};
			}

			const step = params.step;
			if (typeof step !== "number" || !Number.isFinite(step)) {
				return {
					content: [{ type: "text", text: "Error: step required for toggle" }],
					details: {
						action: "toggle",
						todos: [...planTodos],
						error: "step required",
					},
				};
			}

			const item = planTodos.find((t) => t.step === step);
			if (!item) {
				return {
					content: [{ type: "text", text: `Step ${step} not found` }],
					details: {
						action: "toggle",
						todos: [...planTodos],
						error: `step ${step} not found`,
					},
				};
			}

			item.completed = !item.completed;
			syncPlanTodoWidget(ctx);
			return {
				content: [
					{
						type: "text",
						text: `Step ${step} ${item.completed ? "done" : "undone"}`,
					},
				],
				details: { action: "toggle", todos: [...planTodos] },
			};
		},
	});

	// ---- Register Shift+Tab shortcut ----

	pi.registerShortcut("shift+tab", {
		description: "Cycle permission mode (default → plan → auto)",
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

		// Apply tool restrictions
		if (mode === "plan" && prev !== "plan") {
			// Capture active tools only on first plan entry
			if (toolsBeforePlanMode === undefined) {
				toolsBeforePlanMode = pi.getActiveTools();
			}
			pi.setActiveTools(
				uniqueToolNames([
					...toolsBeforePlanMode.filter(
						(t) => !PLAN_MODE_DISABLED_TOOLS.has(t),
					),
					...PLAN_MODE_TOOLS,
				]),
			);
		} else if (mode !== "plan" && prev === "plan") {
			pi.setActiveTools(toolsBeforePlanMode ?? pi.getActiveTools());
			toolsBeforePlanMode = undefined;
		}

		// Clear plan widget on any non-plan mode
		if (mode !== "plan" && ctx.hasUI) {
			ctx.ui.setWidget("plan-todos", undefined);
		}

		// Update status pill + working indicator
		updateStatus(ctx);

		persistState();
	}

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
			toolsBeforePlanMode,
		};
		pi.appendEntry("modes", state);
	}

	// ---------- Footer (mode + cwd/git + provider/model) ----------

	function installFooter(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setFooter((_tui, theme, footerData) => {
			// Seed cached branch eagerly
			if (gitBranch === null) {
				gitBranch = footerData.getGitBranch();
			}
			const unsub = footerData.onBranchChange(() => {
				gitBranch = footerData.getGitBranch();
				_tui.requestRender();
			});
			return {
				dispose() {
					if (typeof unsub === "function") unsub();
				},
				invalidate() {},
				render(width: number): string[] {
					const meta = modeMetadata(currentMode);
					const left =
						`${theme.fg(meta.role, `${meta.icon} ${meta.label}`)} ` +
						theme.fg("dim", "(shift+tab to cycle)");

					const centerParts: string[] = [];
					centerParts.push(ctx.cwd || "");
					if (gitBranch) centerParts.push(gitBranch);
					const centerText = centerParts.filter(Boolean).join(" [");
					const center = theme.fg(
						"dim",
						centerParts.length > 1 ? `${centerText}]` : centerText,
					);

					const right = theme.fg(
						"dim",
						ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no-model",
					);

					const lw = visibleWidth(left);
					const rw = visibleWidth(right);
					const cw = Math.max(0, width - lw - rw - 2);
					const centerVisible = truncateToWidth(center, cw);
					const remaining = Math.max(
						1,
						width - lw - rw - visibleWidth(centerVisible),
					);
					const centerPad = " ".repeat(Math.floor(remaining / 2));

					return [
						truncateToWidth(
							left + centerPad + centerVisible + centerPad + right,
							width,
						),
					];
				},
			};
		});
	}

	// ---------- Working message (streaming stats) ----------

	function computeStats(ctx: ExtensionContext): {
		input: number;
		output: number;
		cost: number;
		pct: number;
	} {
		let input = 0;
		let output = 0;
		let cost = 0;
		for (const e of ctx.sessionManager.getBranch()) {
			if (e.type === "message" && e.message.role === "assistant") {
				const m = e.message as AssistantMessage;
				input += m.usage?.input ?? 0;
				output += m.usage?.output ?? 0;
				cost += m.usage?.cost?.total ?? 0;
			}
		}
		const usage = ctx.getContextUsage?.();
		const tokens = usage?.tokens ?? 0;
		const contextWindow = usage?.contextWindow ?? 0;
		const pct =
			tokens > 0 && contextWindow > 0
				? Math.round((tokens / contextWindow) * 100)
				: 0;
		return { input, output, cost, pct };
	}

	function refreshWorkingMessage(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (streamStart === 0) return;
		const { input, output, pct } = computeStats(ctx);
		const elapsedSec = Math.max(0.001, (Date.now() - streamStart) / 1000);
		const outDelta = Math.max(0, output - outputAtTurnStart);
		const tps = outDelta / elapsedSec;
		const msg = `Working (${elapsedSec.toFixed(1)}s  ↑${formatCount(input)} ↓${formatCount(output)} ${tps.toFixed(1)} tok/s  ${pct}% ctx)`;
		ctx.ui.setWorkingMessage(msg);
	}

	function resetWorkingMessage(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setWorkingMessage();
	}

	// ---------- tool_call gate (the single handler) ----------

	pi.on("tool_call", async (event, ctx) => {
		const tool = event.toolName;
		const input = (event.input ?? {}) as Record<string, unknown>;

		if (currentMode === "plan") {
			if (tool === "edit" || tool === "write") {
				return {
					block: true,
					reason: "Plan mode: edit/write disabled. Use /plan to exit first.",
				};
			}
			if (tool === "bash") {
				const cmd = String(input.command ?? "");
				if (!isSafeCommand(cmd)) {
					return {
						block: true,
						reason: `Plan mode: read-only commands only.\n  Command: ${cmd}`,
					};
				}
			}
			return undefined;
		}

		if (currentMode === "auto") {
			return undefined; // approve everything
		}

		// default mode
		if (tool === "edit" || tool === "write") {
			const path = String(input.path ?? "(unknown)");
			if (!ctx.hasUI) {
				return { block: true, reason: `${tool} blocked: no UI to confirm.` };
			}
			const choice = await ctx.ui.select(`Allow ${tool} on ${path}?`, [
				"Allow",
				"Allow all (enable auto)",
				"Block",
			]);
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
		if (planExecuting && planTodos.length > 0) {
			const remaining = planTodos.filter((t) => !t.completed);
			const todoList = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
			const todoHint =
				planTodos.length > 2
					? "\nUse the todo tool to list and toggle the steps as you finish them."
					: "";
			return {
				message: {
					customType: "modes-context",
					content: `[EXECUTING PLAN — full tool access]

Remaining steps:
${todoList}
${todoHint}

Execute each step in order. After completing a step, include a [DONE:n] tag in your response.`,
					display: false,
				},
			};
		}

		let body: string;
		if (currentMode === "plan") {
			body = `[PLAN MODE ACTIVE]
You are in plan mode — a read-only exploration mode for safe code analysis.

Restrictions:
- edit and write tools are disabled
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
Proceed without asking for confirmation. After completing each meaningful chunk, briefly summarize progress.`;
		} else {
			body = `[DEFAULT MODE ACTIVE]
- edit and write tools require per-call user approval
- mutating bash commands require per-call user approval
- read-only bash and reads (read/grep/find/ls) pass through without prompting`;
		}

		return {
			message: {
				customType: "modes-context",
				content: body,
				display: false,
			},
		};
	});

	// ---------- Stream stats events ----------

	pi.on("turn_start", async (_event, ctx) => {
		streamStart = Date.now();
		const stats = computeStats(ctx);
		outputAtTurnStart = stats.output;
		refreshWorkingMessage(ctx);
	});

	pi.on("before_provider_request", async (_event, ctx) => {
		refreshWorkingMessage(ctx);
	});

	pi.on("message_update", async (_event, ctx) => {
		refreshWorkingMessage(ctx);
	});

	// ---------- agent_end: reset working message (runs first) ----------

	pi.on("agent_end", async (_event, ctx) => {
		streamStart = 0;
		resetWorkingMessage(ctx);
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
			pi.setActiveTools(toolsBeforePlanMode ?? pi.getActiveTools());
			toolsBeforePlanMode = undefined;
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
		// Reset git branch cache; will be re-seeded by installFooter factory
		gitBranch = null;

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
				toolsBeforePlanMode = modesEntry.data.toolsBeforePlanMode;
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

		// 4) Apply tool restrictions
		if (currentMode === "plan" && toolsBeforePlanMode === undefined) {
			toolsBeforePlanMode = pi.getActiveTools();
			pi.setActiveTools(
				uniqueToolNames([
					...toolsBeforePlanMode.filter(
						(t) => !PLAN_MODE_DISABLED_TOOLS.has(t),
					),
					...PLAN_MODE_TOOLS,
				]),
			);
		} else if (currentMode !== "plan" && toolsBeforePlanMode !== undefined) {
			// leftover from a previous run — discard
			toolsBeforePlanMode = undefined;
		}

		// 5) Restore plan-execute widget if applicable
		syncPlanTodoWidget(ctx);

		// 6) Install footer + status
		updateStatus(ctx);
		installFooter(ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		await restoreSession(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		await restoreSession(ctx);
	});
}
