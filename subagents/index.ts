import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { getPermissionModeAccess } from "../permission-modes/mode-access.js";
import { discoverAgents } from "./agents.js";
import { clearRuns, getRun, listRuns, stopRun } from "./registry.js";
import {
	executeSubagentRun,
	formatRunResult,
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
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 3_600_000 })),
});

type SubagentParams = Static<typeof SubagentSchema>;

export interface SubagentExtensionDeps {
	runner?: RunnerDeps;
}

function parentContext(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
): ParentLaunchContext {
	const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
	const thinking = pi.getThinkingLevel() as SubagentThinking;
	return {
		cwd: ctx.cwd,
		model,
		thinking,
		permissionMode: getPermissionModeAccess()?.getMode() ?? "default",
		parentSessionFile: ctx.sessionManager.getSessionFile(),
		extensionPath: fileURLToPath(new URL("../index.ts", import.meta.url)),
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
		children: run.children.map((child) => ({
			index: child.index,
			agent: child.agent,
			task: child.task,
			state: child.state,
			model: child.model,
			startedAt: child.startedAt,
			endedAt: child.endedAt,
			output: child.output,
			error: child.error,
			sessionFile: child.sessionFile,
		})),
	};
}

function activeWidgetLines(): string[] | undefined {
	const active = listRuns().filter(
		(run) => run.state === "queued" || run.state === "running",
	);
	if (!active.length) return undefined;
	return [
		"Subagents",
		...active.map((run) => {
			const done = run.children.filter(
				(child) => child.state === "completed",
			).length;
			const failed = run.children.filter(
				(child) => child.state === "failed",
			).length;
			return `  ${run.id.slice(0, 8)}  ${done}/${run.children.length} done${failed ? `, ${failed} failed` : ""}`;
		}),
	];
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
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: `Delegate a focused task to a configured child Pi agent. Supports one child or a bounded parallel group, fresh or forked context, foreground or background execution, and basic list/status/stop control. Omit model and thinking to inherit the active parent session values at launch. Use fresh context for independent review. Keep parallel tasks read-only unless their filesystems are deliberately isolated; this reduced runtime does not provide worktrees or nested delegation.`,
		promptSnippet: "Delegate focused work to one or more isolated child agents",
		promptGuidelines: [
			"Use subagent for focused, self-contained delegation and independent parallel review.",
			"Keep one writer in the shared checkout; parallel subagent tasks should normally be read-only.",
			"Use subagent action=list before choosing an unfamiliar configured agent.",
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
					return toolResult(formatRunResult(run), { run: publicRun(run) });
				}
				const runs = listRuns();
				const text = runs.length
					? runs
							.map(
								(run) =>
									`${run.id}  ${run.state}  ${run.mode}  ${run.children.length} child(ren)`,
							)
							.join("\n")
					: "No subagent runs are recorded in this process.";
				return toolResult(text, { runs: runs.map(publicRun) });
			}
			if (params.action === "stop") {
				if (!params.id) throw new Error("Subagent stop requires an id.");
				const run = stopRun(params.id);
				ctx.ui.setWidget("aio-subagents", activeWidgetLines());
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
			const updateWidget = () => {
				if (!shuttingDown)
					ctx.ui.setWidget("aio-subagents", activeWidgetLines());
			};
			const updateForeground = (run: SubagentRun) => {
				updateWidget();
				onUpdate?.(
					toolResult(
						`Subagent run ${run.id.slice(0, 8)}: ${run.children.map((child) => `${child.agent}=${child.state}`).join(", ")}`,
						{ run: publicRun(run) },
					),
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

			const run = await executeSubagentRun({
				request,
				agents,
				parent,
				signal,
				onUpdate: updateForeground,
				deps: deps.runner,
			});
			updateWidget();
			return toolResult(formatRunResult(run), { run: publicRun(run) });
		},
	});

	pi.on("session_start", () => {
		shuttingDown = false;
		clearRuns();
	});

	pi.on("session_shutdown", () => {
		shuttingDown = true;
		for (const run of listRuns()) {
			if (run.state === "queued" || run.state === "running") stopRun(run.id);
		}
	});
}
