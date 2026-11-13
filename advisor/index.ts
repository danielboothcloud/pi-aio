/**
 * advisor — a stronger "advisor" model the working (executor) model can
 * consult for strategic guidance. Based on pi-advisor (MIT, RimuruW — see
 * advisor/LICENSE and advisor/UPSTREAM.md).
 *
 * - Tool: `advisor({ stage? })`. One isolated, bounded side call on the
 *   advisor model with a curated transcript (user/assistant text, tool
 *   activity summaries, the executor system prompt). It returns a verdict plus
 *   numbered action items. Capped per agent run (maxUsesPerRun).
 * - Switch: the active recipe's `advisor` key (absent = off; a model = on).
 *   `/advisor on [model] | off | reset` overrides the recipe for the session
 *   (persisted on the branch as an `advisor-state` entry); a live recipe
 *   switch clears that override. `/advisor` alone shows the status. There is
 *   no `/advisor ask`: /btw already covers manual side questions.
 * - Activation: the tool stays registered and is added to / removed from the
 *   active set at session start, before every agent run, and on changes, so
 *   it never fights permission-modes' passive-mode tool snapshot.
 * - Subagents: the parent mirrors its effective settings into AIO_ADVISOR;
 *   children (AIO_SUBAGENT_CHILD=1) read it, register no command, and keep
 *   the tool. The subagent runner adds `advisor` to an agent's tool allowlist
 *   while that env is set.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { sanitizeForTerminal } from "../btw/engine.js";
import { findRecipeModel, type SessionModel } from "../recipes/apply.js";
import { chromeHeader, chromeHint, fitLine, type ChromeTheme } from "../ui/chrome.js";
import {
	ADVISOR_ENV,
	ADVISOR_STATE_ENTRY,
	ADVISOR_TOOL_NAME,
	type AdvisorOverride,
	type AdvisorSettings,
	type AdvisorStateData,
	type EffectiveAdvisor,
	describeAdvisor,
	getRecipeAdvisor,
	latestAdvisorOverride,
	mirrorAdvisorEnv,
	parseAdvisorSetting,
	resolveAdvisor,
	setAdvisorAccess,
} from "./config.js";
import {
	type AdvisorMessage,
	RECENT_TOOL_SUMMARY_COUNT,
	STAGE_DIRECTIVES,
	STAGE_LABELS,
	buildAdvisorMessages,
	buildAdvisorSystemPrompt,
} from "./messages.js";
import {
	ADVISOR_STAGES,
	type AdvisorStage,
	type AdvisorStageInfo,
	type RunToolEvent,
	buildExecutorSignals,
	detectStage,
	summarizeToolResult,
} from "./signals.js";

/** Usage subset reported by the side call (pi-ai Usage shape). */
export interface AdvisorUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface AdvisorResponse {
	content: Array<Record<string, unknown>>;
	stopReason: string;
	errorMessage?: string;
	usage?: AdvisorUsage;
}

/** Narrow seam over ModelRegistry.streamSimple(...).result(); tests inject it. */
export type AdvisorCompleteFn = (
	ctx: ExtensionContext,
	model: SessionModel,
	context: { systemPrompt: string; messages: AdvisorMessage[] },
	options: { reasoning?: string; maxTokens: number; signal?: AbortSignal; sessionId?: string },
) => Promise<AdvisorResponse>;

export interface AdvisorDetails {
	stage: AdvisorStage;
	callNumber: number;
	maxUses: number;
	model: string;
	inputTokens?: number;
	outputTokens?: number;
}

export interface RegisterAdvisorOptions {
	complete?: AdvisorCompleteFn;
}

const PREVIEW_LINES = 6;

const defaultComplete: AdvisorCompleteFn = async (ctx, model, context, options) => {
	// SAFETY: AdvisorMessage is a structural subset of pi-ai's Message, and
	// reasoning is a validated thinking level; the generic SDK types are
	// erased at this single seam.
	const registry = ctx.modelRegistry as unknown as {
		streamSimple(m: unknown, c: unknown, o: unknown): { result(): Promise<AdvisorResponse> };
	};
	return registry.streamSimple(model, context, options).result();
};

function isChild(): boolean {
	return process.env.AIO_SUBAGENT_CHILD === "1";
}

function textOf(content: Array<Record<string, unknown>>, type: "text" | "thinking"): string {
	const key = type === "text" ? "text" : "thinking";
	return content
		.filter((block) => block.type === type && typeof block[key] === "string")
		.map((block) => block[key] as string)
		.join("\n")
		.trim();
}

function chromeOf(theme: Theme): ChromeTheme {
	// SAFETY: shared chrome passes Pi theme roles; this adapter keeps the
	// receiver and bridges its string role type to Pi's role union.
	return {
		fg: (role, text) => theme.fg(role as Parameters<typeof theme.fg>[0], text),
		bold: (text) => theme.bold(text),
	};
}

function rowsComponent(build: (width: number) => string[]) {
	return {
		render: (width: number) => (width <= 0 ? [] : build(width).map((line) => fitLine(line, width))),
		invalidate: () => {},
	};
}

function wrapBody(text: string, width: number, indent = 2): string[] {
	const pad = " ".repeat(indent);
	return text.split("\n").flatMap((line) =>
		line.trim() ? wrapTextWithAnsi(line, Math.max(1, width - indent)).map((part) => `${pad}${part}`) : [""],
	);
}

function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

export function registerAdvisor(pi: ExtensionAPI, options: RegisterAdvisorOptions = {}): void {
	const child = isChild();
	const complete = options.complete ?? defaultComplete;
	// A top-level pi never trusts a stray inherited mirror; only children read it.
	if (!child) delete process.env[ADVISOR_ENV];

	let override: AdvisorOverride;
	let usesThisRun = 0;
	let runEvents: RunToolEvent[] = [];
	let lastCtx: ExtensionContext | undefined;

	const effective = (): EffectiveAdvisor | undefined => resolveAdvisor(override);

	/** Mirror for children and make the active tool set match the state. */
	function sync(): void {
		const current = effective();
		if (!child) mirrorAdvisorEnv(current);
		let active: string[];
		try {
			active = pi.getActiveTools();
		} catch {
			return;
		}
		const has = active.includes(ADVISOR_TOOL_NAME);
		if (current && !has) pi.setActiveTools([...active, ADVISOR_TOOL_NAME]);
		else if (!current && has) pi.setActiveTools(active.filter((name) => name !== ADVISOR_TOOL_NAME));
	}

	function restore(ctx: ExtensionContext): void {
		lastCtx = ctx;
		let entries: readonly unknown[] = [];
		try {
			entries = ctx.sessionManager.getBranch();
		} catch {
			entries = [];
		}
		override = child ? undefined : latestAdvisorOverride(entries);
		sync();
	}

	function persist(next: AdvisorOverride): void {
		override = next;
		const data: AdvisorStateData = { override: next ?? null };
		pi.appendEntry(ADVISOR_STATE_ENTRY, data);
		sync();
	}

	function describeSource(current: EffectiveAdvisor): string {
		if (current.source === "override") return "session override (/advisor on)";
		if (current.source === "recipe") return `recipe "${current.recipe}"`;
		return "inherited from the parent session";
	}

	function statusText(): string {
		const current = effective();
		const recipe = getRecipeAdvisor();
		const lines: string[] = [];
		if (current) {
			const s = current.settings;
			lines.push(
				`Advisor: on — ${describeAdvisor(s)}`,
				`Source: ${describeSource(current)}`,
				`Uses this run: ${usesThisRun}/${s.maxUsesPerRun} · max tokens ${s.maxTokens} · context messages ${s.maxContextMessages}`,
			);
		} else {
			lines.push(
				`Advisor: off${override?.mode === "off" ? " — session override (/advisor off)" : ""}`,
			);
		}
		if (recipe && current?.source !== "recipe") {
			lines.push(`Recipe "${recipe.recipe}" sets: ${describeAdvisor(recipe.settings)}`);
		}
		if (!recipe) lines.push("No active recipe sets an advisor.");
		lines.push("Commands: /advisor on [provider/model[:reasoning]] · /advisor off · /advisor reset");
		return lines.join("\n");
	}

	const access = {
		followRecipe(ctx: ExtensionContext) {
			lastCtx = ctx;
			if (override) persist(undefined);
			else sync();
		},
	};
	setAdvisorAccess(access);

	pi.on("session_start", (_event, ctx) => {
		setAdvisorAccess(access);
		usesThisRun = 0;
		runEvents = [];
		restore(ctx);
	});
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("before_agent_start", (_event, ctx) => {
		lastCtx = ctx;
		sync();
	});
	pi.on("agent_start", () => {
		usesThisRun = 0;
		runEvents = [];
	});
	pi.on("tool_result", (event) => {
		if (event.toolName === ADVISOR_TOOL_NAME) return;
		runEvents.push(summarizeToolResult(event));
		if (runEvents.length > 200) runEvents = runEvents.slice(-200);
	});
	pi.on("session_shutdown", () => {
		lastCtx = undefined;
		if (!child) delete process.env[ADVISOR_ENV];
	});

	function activeToolsSummary(): string {
		try {
			const active = new Set(pi.getActiveTools().filter((name) => name !== ADVISOR_TOOL_NAME));
			const tools = pi
				.getAllTools()
				.filter((tool) => active.has(tool.name))
				.sort((a, b) => a.name.localeCompare(b.name));
			if (tools.length === 0) return "- No active tools recorded";
			return tools
				.map((tool) => `- ${tool.name}: ${tool.description.replace(/\s+/g, " ").trim().slice(0, 160)}`)
				.join("\n");
		} catch {
			return "- No active tools recorded";
		}
	}

	function resolveModel(ctx: ExtensionContext, settings: AdvisorSettings): SessionModel {
		const model = findRecipeModel(ctx, settings.model);
		if (!model) throw new Error(`Advisor model "${settings.model}" was not found. Continue without advice.`);
		return model;
	}

	pi.registerTool({
		name: ADVISOR_TOOL_NAME,
		label: "Advisor",
		description:
			"Consult a stronger advisor model for strategic guidance. Returns a verdict (On track / Course-correct / Not done yet) plus numbered action items. The advisor sees the conversation transcript, your system prompt, and recent tool activity. It cannot call tools.",
		promptSnippet: "advisor({ stage? }): consult a stronger model for strategic guidance → verdict + action items",
		promptGuidelines: [
			"Call advisor({ stage: 'initial' }) for non-trivial tasks after 2-3 reads, before committing to an approach.",
			"Call advisor({ stage: 'recovery' }) when stuck, confused, or after a failed attempt.",
			"Call advisor({ stage: 'final-check' }) after implementation and verification, before declaring the task complete.",
			"Call advisor() without a stage to auto-detect it.",
			"Do not call advisor for syntax questions, API lookups, routine steps, tasks done in under 5 tool calls, or while your current plan is working.",
			"You remain the executor: the advisor only advises. Follow its action items unless evidence contradicts them; then state the conflict explicitly.",
		],
		parameters: Type.Object({
			stage: Type.Optional(
				StringEnum(ADVISOR_STAGES, {
					description: "initial (exploring), recovery (stuck/off-track), or final-check (before completion)",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const current = effective();
			if (!current) throw new Error("The advisor is off for this session. Continue without advice.");
			const settings = current.settings;
			if (usesThisRun >= settings.maxUsesPerRun) {
				throw new Error(
					`Advisor usage limit reached (${settings.maxUsesPerRun} per run). Continue without advisor guidance.`,
				);
			}
			const model = resolveModel(ctx, settings);
			const stageInfo: AdvisorStageInfo = params.stage
				? { stage: params.stage, reason: "Executor explicitly signaled this stage." }
				: detectStage(runEvents, usesThisRun + 1);
			const activity = runEvents
				.slice(-RECENT_TOOL_SUMMARY_COUNT)
				.map((event) => `- ${event.summary}`)
				.join("\n");
			const messages = buildAdvisorMessages(
				ctx.sessionManager.getBranch(),
				{ ...stageInfo, directive: STAGE_DIRECTIVES[stageInfo.stage] },
				activity,
				settings.maxContextMessages,
				buildExecutorSignals(runEvents),
			);
			if (messages.length === 0) {
				throw new Error("No conversation context is available for the advisor. Continue without advice.");
			}

			// Count only once a real model call is about to happen.
			usesThisRun++;
			const callNumber = usesThisRun;
			let sessionId: string | undefined;
			try {
				sessionId = ctx.sessionManager.getSessionId();
			} catch {
				sessionId = undefined;
			}
			const response = await complete(
				ctx,
				model,
				{ systemPrompt: buildAdvisorSystemPrompt(ctx.getSystemPrompt(), activeToolsSummary()), messages },
				{
					reasoning: settings.reasoning === "off" ? undefined : settings.reasoning,
					maxTokens: settings.maxTokens,
					signal,
					// Session-affine cache routing: repeat consultations share a prefix.
					sessionId,
				},
			);
			if (response.stopReason === "aborted") throw new Error("Advisor call aborted.");
			if (response.stopReason === "error") {
				throw new Error(`Advisor call failed: ${response.errorMessage ?? "unknown error"}. Continue without advice.`);
			}
			const advice = textOf(response.content, "text");
			const thinking = textOf(response.content, "thinking");
			const text = advice || (thinking ? `(thinking)\n${thinking}` : "");
			if (!text) {
				throw new Error(
					`Advisor returned an empty response (model ${model.provider}/${model.id}, stop: ${response.stopReason}). Continue without advice.`,
				);
			}
			const details: AdvisorDetails = {
				stage: stageInfo.stage,
				callNumber,
				maxUses: settings.maxUsesPerRun,
				model: `${model.provider}/${model.id}`,
				inputTokens: response.usage?.input,
				outputTokens: response.usage?.output,
			};
			return {
				content: [{ type: "text" as const, text }],
				details,
				...(response.usage ? { usage: response.usage } : {}),
			};
		},
		renderCall(args, theme) {
			const chrome = chromeOf(theme);
			const current = effective();
			const stage = args?.stage ? STAGE_LABELS[args.stage as AdvisorStage] : "auto stage";
			const meta = current ? `${current.settings.model} · ${stage}` : stage;
			return rowsComponent((width) => [chromeHeader(chrome, { title: "Advisor", meta, icon: "◇" }, width)]);
		},
		renderResult(result, renderOptions, theme, context) {
			const chrome = chromeOf(theme);
			if (renderOptions.isPartial) {
				return rowsComponent((width) => [chromeHint(chrome, "consulting the advisor…", width)]);
			}
			const first = result.content[0];
			const raw = first?.type === "text" ? first.text : "";
			const text = sanitizeForTerminal(raw, 20_000);
			if (context?.isError) {
				return rowsComponent((width) => wrapBody(theme.fg("error", text || "Advisor unavailable"), width));
			}
			const details = result.details as AdvisorDetails | undefined;
			return rowsComponent((width) => {
				const lines = text.split("\n");
				const truncated = !renderOptions.expanded && lines.length > PREVIEW_LINES;
				const shown = truncated ? lines.slice(0, PREVIEW_LINES).join("\n") : text;
				const rows = wrapBody(shown, width);
				if (truncated) rows.push(chromeHint(chrome, `… ${lines.length - PREVIEW_LINES} more lines (expand to read)`, width));
				if (details) {
					const parts = [
						details.stage ? STAGE_LABELS[details.stage] : undefined,
						`#${details.callNumber}/${details.maxUses}`,
						details.inputTokens !== undefined ? `↑${formatTokens(details.inputTokens)}` : undefined,
						details.outputTokens !== undefined ? `↓${formatTokens(details.outputTokens)}` : undefined,
						details.model,
					].filter(Boolean);
					rows.push(chromeHint(chrome, parts.join(" · "), width));
				}
				return rows;
			});
		},
	});

	// Children are headless: no command surface, the tool only.
	if (child) return;

	const SUBCOMMANDS = [
		{ value: "status", description: "Show the advisor state" },
		{ value: "on", description: "Turn the advisor on for this session (optional provider/model[:reasoning])" },
		{ value: "off", description: "Turn the advisor off for this session" },
		{ value: "reset", description: "Drop the session override and follow the recipe" },
	];

	pi.registerCommand("advisor", {
		description: "Advisor status, or override the recipe for this session: on [model] | off | reset",
		getArgumentCompletions: (prefix: string) => {
			const trimmed = prefix.trimStart();
			if (!trimmed.includes(" ")) {
				const matches = SUBCOMMANDS.filter((s) => s.value.startsWith(trimmed.toLowerCase()));
				return matches.length > 0
					? matches.map((s) => ({ value: s.value, label: s.value, description: s.description }))
					: null;
			}
			const [sub, partial = ""] = trimmed.split(/\s+/, 2);
			if (sub?.toLowerCase() !== "on" || !lastCtx) return null;
			try {
				const ids = lastCtx.modelRegistry
					.getAvailable()
					.map((model) => `${model.provider}/${model.id}`)
					.filter((id) => id.startsWith(partial))
					.slice(0, 40);
				return ids.length > 0 ? ids.map((id) => ({ value: `on ${id}`, label: id })) : null;
			} catch {
				return null;
			}
		},
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const [rawSub = "", ...rest] = (args ?? "").trim().split(/\s+/);
			const sub = rawSub.toLowerCase();
			const spec = rest.join(" ").trim();

			if (sub === "" || sub === "status") {
				ctx.ui.notify(statusText(), "info");
				return;
			}
			if (sub === "off") {
				persist({ mode: "off" });
				ctx.ui.notify("Advisor: off for this session (/advisor reset follows the recipe again)", "info");
				return;
			}
			if (sub === "reset" || sub === "recipe" || sub === "auto") {
				persist(undefined);
				const current = effective();
				ctx.ui.notify(
					current ? `Advisor: following the recipe — ${describeAdvisor(current.settings)}` : "Advisor: following the recipe — off",
					"info",
				);
				return;
			}
			if (sub !== "on") {
				ctx.ui.notify(`Unknown /advisor subcommand "${rawSub}".\n${statusText()}`, "warning");
				return;
			}

			let settings: AdvisorSettings | undefined;
			if (spec) {
				const parsed = parseAdvisorSetting(spec);
				const recipe = getRecipeAdvisor()?.settings;
				// Keep the recipe's limits; the command only picks model + reasoning.
				settings = parsed && recipe ? { ...recipe, model: parsed.model, reasoning: parsed.reasoning } : parsed;
			} else {
				settings = override?.mode === "on" ? override.settings : getRecipeAdvisor()?.settings;
			}
			if (!settings) {
				ctx.ui.notify("Name a model: /advisor on provider/model[:reasoning] (no recipe sets an advisor)", "warning");
				return;
			}
			if (!findRecipeModel(ctx, settings.model)) {
				ctx.ui.notify(`Advisor model "${settings.model}" was not found`, "error");
				return;
			}
			persist({ mode: "on", settings });
			ctx.ui.notify(`Advisor: on for this session — ${describeAdvisor(settings)}`, "info");
		},
	});
}
