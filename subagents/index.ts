import { StringEnum } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
	chromeHeader,
	chromeHint,
	chromeItem,
	plural,
	type ChromeTheme,
} from "../ui/chrome.js";
import { formatChildActivity, formatRunProgress } from "./activity.js";
import { discoverAgents } from "./agents.js";
import { resolveChildExtensionLaunch } from "./extensions.js";
import { SubagentInspector } from "./inspector.js";
import { clearRuns, getRun, listRuns, stopRun } from "./registry.js";
import {
	executeSubagentRun,
	formatRunResult,
	childResumeUnavailable,
	resumeSubagentChild,
	type RunnerDeps,
} from "./runner.js";
import type {
	ParentLaunchContext,
	SubagentRun,
	SubagentThinking,
} from "./types.js";

const THINKING_VALUES = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

const TaskSchema = Type.Object({
	agent: Type.String({ minLength: 1, description: "Configured agent name" }),
	task: Type.String({
		minLength: 1,
		description: "Concrete task for this child",
	}),
	model: Type.Optional(
		Type.String({
			minLength: 1,
			description:
				"Per-task model override; omitted inherits the parent session model",
		}),
	),
	thinking: Type.Optional(StringEnum(THINKING_VALUES)),
});

const SubagentSchema = Type.Object({
	action: Type.Optional(StringEnum(["list", "status", "stop"] as const)),
	id: Type.Optional(
		Type.String({ description: "Run id or unique id prefix for status/stop" }),
	),
	agent: Type.Optional(
		Type.String({ description: "Agent name for a single run" }),
	),
	task: Type.Optional(Type.String({ description: "Task for a single run" })),
	tasks: Type.Optional(
		Type.Array(TaskSchema, {
			minItems: 1,
			maxItems: 12,
			description: "Independent tasks to execute in parallel",
		}),
	),
	context: Type.Optional(StringEnum(["fresh", "fork"] as const)),
	async: Type.Optional(
		Type.Boolean({
			description: "Run in the background and return a run id immediately",
		}),
	),
	concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })),
	model: Type.Optional(
		Type.String({
			minLength: 1,
			description:
				"Run-wide model override; omitted inherits the parent session model",
		}),
	),
	thinking: Type.Optional(StringEnum(THINKING_VALUES)),
	timeoutMs: Type.Optional(
		Type.Integer({
			minimum: 1000,
			maximum: 21_600_000,
			description:
				"Hard budget per child in milliseconds (1s to 6h). Defaults to the agent's declared timeoutMs, or 15 minutes when unset. A timed-out child is retried once with its session resumed.",
		}),
	),
});

type SubagentParams = Static<typeof SubagentSchema>;

export interface SubagentExtensionDeps {
	runner?: RunnerDeps;
}

function parentContext(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
): ParentLaunchContext {
	const modelProvider = ctx.model?.provider;
	const model = ctx.model ? `${modelProvider}/${ctx.model.id}` : undefined;
	const thinking = pi.getThinkingLevel() as SubagentThinking;
	return {
		cwd: ctx.cwd,
		model,
		modelProvider,
		thinking,
		parentSessionFile: ctx.sessionManager.getSessionFile(),
		extensionLaunch: resolveChildExtensionLaunch({ modelProvider }),
	};
}

function publicRun(run: SubagentRun): Record<string, unknown> {
	return {
		id: run.id,
		state: run.state,
		mode: run.mode,
		context: run.context,
		cwd: run.cwd,
		startedAt: run.startedAt,
		endedAt: run.endedAt,
		error: run.error,
		resumedFrom: run.resumedFrom,
		children: run.children.map((child) => ({
			index: child.index,
			agent: child.agent,
			task: child.task,
			state: child.state,
			model: child.model,
			thinking: child.thinking,
			startedAt: child.startedAt,
			endedAt: child.endedAt,
			output: child.output,
			error: child.error,
			sessionFile: child.sessionFile,
			attempts: child.attempts ?? 1,
			activity: child.activity
				? {
						...child.activity,
						runningTools: child.activity.runningTools.map((tool) => ({
							...tool,
						})),
					}
				: undefined,
			reapedAfterSettle: child.reapedAfterSettle,
		})),
	};
}

/** Opens the live subagent inspector overlay (also `/subagents`). */
// Use a plain Control chord: Option-letter keys can produce text on macOS.
export const INSPECTOR_SHORTCUT = "ctrl+s";

/** Running children shown under a parallel run before collapsing to a hint. */
const MAX_CHILD_ROWS = 3;

export function buildSubagentWidgetLines(
	active: readonly SubagentRun[],
	width: number,
	theme: ChromeTheme,
	maxRows = 4,
	now = Date.now(),
): string[] {
	if (active.length === 0 || width <= 0) return [];
	const lines = [
		chromeHeader(
			theme,
			{
				title: "subagents",
				meta: `${plural(active.length, "active run")} · ${INSPECTOR_SHORTCUT} inspect`,
			},
			width,
		),
	];
	const visible = active.slice(0, Math.max(1, maxRows));
	for (const run of visible) {
		const marker = run.state === "running" ? "◐" : "◌";
		const only = run.children.length === 1 ? run.children[0] : undefined;
		if (only) {
			// Single child: one row carrying its live activity.
			const { text, stale } = formatChildActivity(only, now);
			lines.push(
				chromeItem(
					theme,
					{
						label: `${run.id.slice(0, 8)} ${only.agent}`,
						meta: text,
						marker,
						tone: stale || only.state === "failed" ? "warning" : "accent",
						indent: 1,
					},
					width,
				),
			);
			continue;
		}
		const done = run.children.filter(
			(child) => child.state === "completed",
		).length;
		const failed = run.children.filter(
			(child) => child.state === "failed",
		).length;
		lines.push(
			chromeItem(
				theme,
				{
					label: run.id.slice(0, 8),
					meta: `${done}/${run.children.length} done${failed ? ` · ${failed} failed` : ""}`,
					marker,
					tone: failed ? "warning" : "accent",
					indent: 1,
				},
				width,
			),
		);
		const running = run.children.filter((child) => child.state === "running");
		for (const child of running.slice(0, MAX_CHILD_ROWS)) {
			const { text, stale } = formatChildActivity(child, now);
			lines.push(
				chromeItem(
					theme,
					{
						label: child.agent,
						meta: text,
						marker: "↳",
						tone: stale ? "warning" : "muted",
						indent: 3,
					},
					width,
				),
			);
		}
		if (running.length > MAX_CHILD_ROWS)
			lines.push(
				chromeHint(theme, `+${running.length - MAX_CHILD_ROWS} more running`, width, 5),
			);
	}
	const remaining = active.length - visible.length;
	if (remaining > 0) lines.push(chromeHint(theme, `+${remaining} more runs`, width));
	return lines;
}

/** Live elapsed/quiet timers need a repaint even when the child is silent. */
const ACTIVITY_TICK_MS = 1_000;

function activeRuns(): SubagentRun[] {
	return listRuns().filter(
		(run) => run.state === "queued" || run.state === "running",
	);
}

function activeWidgetContent() {
	const active = activeRuns();
	if (!active.length) return undefined;
	return (_tui: TUI, theme: Theme) => ({
		invalidate() {},
		render(width: number): string[] {
			return buildSubagentWidgetLines(active, width, theme);
		},
	});
}

function runActivitySuffix(run: SubagentRun): string {
	if (run.state !== "running") return "";
	const now = Date.now();
	return run.children
		.map((child) => `\n  ${child.agent} · ${formatChildActivity(child, now).text}`)
		.join("");
}

function toolResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function formatAgentList(cwd: string, includeProject: boolean): string {
	const agents = discoverAgents(cwd, { includeProject });
	return agents.length
		? agents
				.map(
					(agent) => `- ${agent.name} (${agent.source}): ${agent.description}`,
				)
				.join("\n")
		: "No subagents are configured.";
}

export function registerSubagents(
	pi: ExtensionAPI,
	deps: SubagentExtensionDeps = {},
): void {
	let shuttingDown = false;
	let sessionEpoch = 0;
	let closeInspector: (() => void) | undefined;
	const openInspector = async (ctx: ExtensionContext): Promise<void> => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify(
				"The subagent inspector is only available in the interactive TUI; use subagent action=status instead.",
				"warning",
			);
			return;
		}
		if (closeInspector) return;
		if (listRuns().length === 0) {
			ctx.ui.notify("No subagent runs in this session yet.", "info");
			return;
		}
		try {
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => {
					const inspector = new SubagentInspector({
						theme,
						getRuns: listRuns,
						getMaxRows: () => Math.floor(tui.terminal.rows * 0.9),
						requestRender: () => tui.requestRender(),
						done: () => done(undefined),
						resumeUnavailable: ({ run, child }) => childResumeUnavailable(run, child),
						resumeChild: ({ run, child }) => {
							if (shuttingDown) return;
							const epoch = sessionEpoch;
							let focused = false;
							void resumeSubagentChild({
								run,
								child,
								deps: deps.runner,
								onUpdate: (continuation) => {
									if (shuttingDown || epoch !== sessionEpoch) return;
									trackWidget(ctx);
									if (!focused) {
										focused = true;
										inspector.inspectRun(continuation);
									}
								},
							}).then((continuation) => {
								if (shuttingDown || epoch !== sessionEpoch) return;
								trackWidget(ctx);
								pi.sendMessage({
									customType: "aio-subagent-complete",
									content: formatRunResult(continuation),
									display: true,
									details: publicRun(continuation),
								}, { deliverAs: "followUp", triggerTurn: true });
							}).catch((error) => {
								if (shuttingDown || epoch !== sessionEpoch) return;
								ctx.ui.notify(`Could not resume subagent: ${error instanceof Error ? error.message : String(error)}`, "warning");
							});
						},
					});
					closeInspector = () => inspector.close();
					return inspector;
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "center",
						margin: 1,
						maxHeight: "90%",
						minWidth: 50,
						width: "90%",
					},
				},
			);
		} finally {
			closeInspector = undefined;
		}
	};
	pi.registerCommand("subagents", {
		description:
			"Inspect subagent runs live: thinking, responses, tool calls and results, logs",
		handler: async (_args, ctx) => openInspector(ctx),
	});
	pi.registerShortcut(INSPECTOR_SHORTCUT, {
		description: "Open the live subagent inspector",
		handler: openInspector,
	});
	let widgetCtx: ExtensionContext | undefined;
	let widgetTicker: NodeJS.Timeout | undefined;
	const stopWidgetTicker = () => {
		if (widgetTicker) clearInterval(widgetTicker);
		widgetTicker = undefined;
	};
	const refreshWidget = () => {
		if (shuttingDown || !widgetCtx) return;
		try {
			widgetCtx.ui.setWidget("aio-subagents", activeWidgetContent());
		} catch {
			// A replaced session invalidates the captured context.
			stopWidgetTicker();
			return;
		}
		if (activeRuns().length === 0) stopWidgetTicker();
	};
	// Keeps the widget's elapsed/quiet timers moving for foreground and
	// background runs alike; stops itself once no run is active.
	const trackWidget = (ctx: ExtensionContext) => {
		widgetCtx = ctx;
		refreshWidget();
		if (widgetTicker || !ctx.hasUI || activeRuns().length === 0) return;
		widgetTicker = setInterval(refreshWidget, ACTIVITY_TICK_MS);
		widgetTicker.unref?.();
	};
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: `Delegate a focused task to a configured child Pi agent. Supports one child or a bounded parallel group, fresh or forked context, foreground or background execution, and basic list/status/stop control. Omit model and thinking to inherit the active parent session values at launch. Use fresh context for independent review. Keep parallel tasks read-only unless their filesystems are deliberately isolated; this reduced runtime does not provide worktrees or nested delegation. A child killed by a stall, timeout, or crash is retried automatically and resumes its own session, so completed work is preserved; a final failure reports the preserved session file.`,
		promptSnippet: "Delegate focused work to one or more isolated child agents",
		promptGuidelines: [
			"Use subagent for focused, self-contained delegation and independent parallel review.",
			"Keep one writer in the shared checkout; parallel subagent tasks should normally be read-only.",
			"Use subagent action=list before choosing an unfamiliar configured agent.",
			"Budget timeoutMs generously for research-heavy tasks: the default is 15 minutes, and tight budgets kill healthy children mid-request and waste the tokens they already spent.",
			"If a child fails after its automatic retry, narrow or split the task instead of re-sending it unchanged.",
		],
		parameters: SubagentSchema,
		async execute(_toolCallId, params: SubagentParams, signal, onUpdate, ctx) {
			const includeProject = ctx.isProjectTrusted();
			if (params.action === "list") {
				const text = formatAgentList(ctx.cwd, includeProject);
				return toolResult(text, {
					agents: discoverAgents(ctx.cwd, { includeProject }).map((agent) => ({
						name: agent.name,
						description: agent.description,
						source: agent.source,
					})),
				});
			}
			if (params.action === "status") {
				if (params.id) {
					const run = getRun(params.id);
					if (!run)
						throw new Error(
							`Unknown or ambiguous subagent run '${params.id}'.`,
						);
					const active = run.state === "queued" || run.state === "running";
					return toolResult(
						active ? formatRunProgress(run, Date.now()) : formatRunResult(run),
						{ run: publicRun(run) },
					);
				}
				const runs = listRuns();
				const text = runs.length
					? runs
							.map(
								(run) =>
									`${run.id}  ${run.state}  ${run.mode}  ${run.children.length} child(ren)${runActivitySuffix(run)}`,
							)
							.join("\n")
					: "No subagent runs are recorded in this process.";
				return toolResult(text, { runs: runs.map(publicRun) });
			}
			if (params.action === "stop") {
				if (!params.id) throw new Error("Subagent stop requires an id.");
				const run = stopRun(params.id);
				trackWidget(ctx);
				return toolResult(`Subagent run ${run.id} is ${run.state}.`, {
					run: publicRun(run),
				});
			}
			if (params.action !== undefined)
				throw new Error(`Unsupported subagent action '${params.action}'.`);

			const request = {
				agent: params.agent,
				task: params.task,
				tasks: params.tasks,
				context: params.context,
				async: params.async,
				concurrency: params.concurrency,
				model: params.model,
				thinking: params.thinking,
				timeoutMs: params.timeoutMs,
			};
			const agents = discoverAgents(ctx.cwd, { includeProject });
			const parent = parentContext(ctx, pi);
			const updateWidget = () => trackWidget(ctx);
			let foregroundRun: SubagentRun | undefined;
			const updateForeground = (run: SubagentRun) => {
				foregroundRun = run;
				updateWidget();
				if (shuttingDown) return;
				onUpdate?.(
					toolResult(formatRunProgress(run, Date.now()), {
						run: publicRun(run),
					}),
				);
			};

			if (params.async) {
				const existingRunIds = new Set(listRuns().map((run) => run.id));
				const promise = executeSubagentRun({
					request,
					agents,
					parent,
					onUpdate: updateWidget,
					deps: deps.runner,
				});
				void promise.catch(() => undefined);
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
				const launchedRun = listRuns().find(
					(run) => !existingRunIds.has(run.id),
				);
				if (!launchedRun) {
					await promise;
					throw new Error("Subagent background launch did not create a run.");
				}
				void promise
					.then((run) => {
						if (shuttingDown) return;
						updateWidget();
						pi.sendMessage(
							{
								customType: "aio-subagent-complete",
								content: formatRunResult(run),
								display: true,
								details: publicRun(run),
							},
							{ deliverAs: "followUp", triggerTurn: true },
						);
					})
					.catch((error) => {
						if (shuttingDown) return;
						updateWidget();
						pi.sendMessage(
							{
								customType: "aio-subagent-complete",
								content: `Subagent launch failed: ${error instanceof Error ? error.message : String(error)}`,
								display: true,
							},
							{ deliverAs: "followUp", triggerTurn: true },
						);
					});
				return toolResult(
					`Subagent run ${launchedRun.id} started in the background.`,
					{ run: publicRun(launchedRun) },
				);
			}

			// Repaint the tool card each second so elapsed and quiet times move
			// even while the child is silent (a long command, a stalled provider).
			const foregroundTicker = setInterval(() => {
				if (foregroundRun?.state === "running") updateForeground(foregroundRun);
			}, ACTIVITY_TICK_MS);
			foregroundTicker.unref?.();
			let run: SubagentRun;
			try {
				run = await executeSubagentRun({
					request,
					agents,
					parent,
					signal,
					onUpdate: updateForeground,
					deps: deps.runner,
				});
			} finally {
				clearInterval(foregroundTicker);
			}
			updateWidget();
			return toolResult(formatRunResult(run), { run: publicRun(run) });
		},
	});

	pi.on("session_start", () => {
		sessionEpoch++;
		shuttingDown = false;
		clearRuns();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		sessionEpoch++;
		shuttingDown = true;
		closeInspector?.();
		stopWidgetTicker();
		widgetCtx = undefined;
		for (const run of listRuns()) {
			if (run.state === "queued" || run.state === "running") stopRun(run.id);
		}
		if (ctx.hasUI) ctx.ui.setWidget("aio-subagents", undefined);
	});
}
